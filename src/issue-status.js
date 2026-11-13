import { randomUUID } from 'node:crypto';
import { githubOrigin, githubRepo, githubStatus } from './github.js';
import { git, verifyTarget } from './worktrees.js';

export const HEARTBEAT_MS = 5 * 60 * 1000;
const owned = ['in-progress', 'in-review', 'blocked'];
const terminalBlocked = new Set(['blocked', 'failed', 'interrupted', 'stopped']);
const activitySummaries = {
  'thread.started': 'Codex opened its session.',
  'turn.started': 'Codex began processing the task.',
  'turn.completed': 'Codex finished its turn.',
  reasoning: 'Codex reported reasoning activity.',
  file_change: 'Codex reported a file change.',
  command_execution: 'A local command finished.',
  agent_message: 'Codex produced a response.'
};

export function observeProgress(state, attempt, event, at) {
  if (typeof event.type !== 'string') return false;
  if (event.type === 'worker-started' && Number.isSafeInteger(event.pid) && event.pid > 0) {
    state.observeAttempt(attempt, { launched: at });
    return true;
  }
  // Publish controlled phrases only. Raw model output can contain secrets or mentions.
  const kind = event.type.startsWith('item.') ? event.itemType : event.type;
  if (Object.hasOwn(activitySummaries, kind)) {
    const summary = kind === 'command_execution' && event.type !== 'item.completed'
      ? 'Codex reported a local command in progress.' : activitySummaries[kind];
    state.observeAttempt(attempt, { activity: at, summary });
  }
  return false;
}

const validId = id => Number.isSafeInteger(id) && id > 0;
const pullUrl = (repo, pull) => 'https://github.com/' + repo + '/pull/' + pull;

function launchTime(attempt) {
  return attempt.launched ?? (attempt.pid || attempt.session ? attempt.started : null);
}

function matchesHandoff(candidate, task, repo) {
  return validId(candidate?.number) && candidate.state === 'open' &&
    candidate.html_url?.toLowerCase() === pullUrl(repo, candidate.number) &&
    candidate.head?.ref === task.branch && candidate.head?.repo?.full_name?.toLowerCase() === repo &&
    candidate.base?.ref === 'main' && candidate.base?.repo?.full_name?.toLowerCase() === repo;
}

function commentBody(attempt, marker, repo, pull, now, recoveryHold) {
  const launched = launchTime(attempt);
  const duration = Math.max(0, Math.floor((Date.parse(attempt.completed ?? now) - Date.parse(launched)) / 1000));
  const outcome = { running: 'In progress', done: pull ? 'Ready for review' : 'Completed locally. Awaiting PR handoff.',
    blocked: 'Blocked. Needs intervention.', failed: 'Failed. Needs intervention.',
    interrupted: 'Interrupted. Review the local worker state.', stopped: 'Stopped.' }[attempt.state];
  const last = attempt.activity ? 'Last observed activity: ' + attempt.activity : 'No activity observed since launch.';
  const quiet = attempt.state === 'running' && attempt.activity &&
    Date.parse(now) - Date.parse(attempt.activity) >= HEARTBEAT_MS ? 'No new activity observed in the last five minutes.' : null;
  return ['<!-- agent-orchestrator-progress:' + marker + ' -->', '**Agent Orchestrator · attempt ' + attempt.id + '**',
    '', outcome,
    recoveryHold === 'recovery-budget-exhausted' ? 'Automatic recovery budget exhausted.' :
      recoveryHold === 'verification-runner-required' ? 'An approved verification runner is required.' :
      recoveryHold === 'verification-runner-unavailable' ? 'The approved verification runner is unavailable or has changed.' : null,
    '', 'Elapsed: ' + Math.floor(duration / 60) + 'm ' + duration % 60 + 's.',
    last, quiet, attempt.summary, pull && 'Pull request: ' + pullUrl(repo, pull)].filter(line => line != null).join('\n');
}

async function publishComment(state, api, repo, attempt, pull, options, now, recoveryHold) {
  const marker = attempt.marker ?? randomUUID();
  const body = commentBody(attempt, marker, repo, pull, now, recoveryHold);
  const actor = await api.viewer(options);
  if (!validId(actor)) throw new Error('Invalid GitHub publisher account');
  if (attempt.actor && attempt.actor !== actor) {
    state.updateProgress(attempt.id, { error: 'publisher-account-changed' });
    return;
  }
  const prefix = '<!-- agent-orchestrator-progress:' + marker + ' -->\n';
  const matches = (await api.comments(repo, attempt.number, options)).filter(item =>
    validId(item?.id) && item.user?.id === actor && typeof item.body === 'string' && item.body.startsWith(prefix));
  if (matches.length > 1 || (attempt.comment && matches[0]?.id !== attempt.comment)) {
    state.updateProgress(attempt.id, { error: 'progress-comment-missing-or-ambiguous' });
    return;
  }
  if (matches.length) {
    const existing = matches[0];
    state.updateProgress(attempt.id, { marker, actor, comment: existing.id, posting: 0 });
    if (existing.body !== body) await api.edit(repo, existing.id, body, options);
    return;
  }
  if (attempt.posting) {
    // GitHub provides no create-comment idempotency key. A lost response may still commit.
    state.updateProgress(attempt.id, { error: 'progress-comment-delivery-unconfirmed' });
    return;
  }
  state.updateProgress(attempt.id, { marker, actor, posting: 1 });
  let posted;
  try {
    posted = await api.post(repo, attempt.number, body, options);
  } catch (error) {
    if ([401, 403, 404, 422, 429].includes(error.status)) state.updateProgress(attempt.id, { posting: 0 });
    throw error;
  }
  if (!validId(posted?.id) || posted.user?.id !== actor || posted.body !== body) throw new Error('Unconfirmed progress comment');
  state.updateProgress(attempt.id, { comment: posted.id, posting: 0 });
}

export function statusPublisher(state, sourceRepo, { api = githubStatus, signal, clock = () => new Date().toISOString(), numbers } = {}) {
  const repo = githubRepo(sourceRepo);
  const options = { signal };
  async function sync(number) {
    const task = state.task(number);
    if (!task || signal?.aborted || (numbers && !numbers.has(number))) return;
    const attempts = state.githubProgress(number);
    const latest = attempts.at(-1);
    const status = state.githubStatusRows().find(row => row.number === number);
    let handoff = status?.pull ?? null;
    let handoffError;
    if (!handoff && task.state === 'done' && latest && launchTime(latest)) {
      try {
        const matches = (await api.openPulls(repo, task.branch, options)).filter(candidate => matchesHandoff(candidate, task, repo));
        if (matches.length === 1) {
          handoff = matches[0].number;
          state.updateGithubStatus(number, { pull: handoff });
        } else if (matches.length > 1) handoffError = 'handoff-ambiguous';
      } catch { handoffError = 'handoff-lookup-failed'; }
    }
    const label = terminalBlocked.has(task.state) ? 'blocked' : task.state === 'done' && handoff ? 'in-review'
      : task.state === 'running' && latest && launchTime(latest) ? 'in-progress' : null;
    if (!label && !attempts.some(launchTime)) return;
    let issue;
    try {
      issue = await api.issue(repo, number, options);
      if (issue.number !== number || issue.pull_request || !Array.isArray(issue.labels) ||
          typeof issue.html_url !== 'string' || issue.html_url.toLowerCase() !== 'https://github.com/' + repo + '/issues/' + number) {
        throw new Error('Unexpected issue');
      }
    } catch {
      state.updateGithubStatus(number, { error: 'issue-lookup-failed' });
      return;
    }
    try {
      if (issue.state === 'open') {
        const labels = new Set(issue.labels.map(item => item.name?.toLowerCase()));
        if (label && !labels.has(label)) await api.add(repo, number, label, options);
        for (const previous of owned) {
          if (previous !== label && labels.has(previous)) await api.remove(repo, number, previous, options);
        }
      }
      state.updateGithubStatus(number, { error: handoffError });
    } catch {
      state.updateGithubStatus(number, { error: 'label-update-failed' });
    }
    const recoveryHold = state.recoveryRows().find(row => row.number === number)?.hold;
    for (const attempt of attempts) {
      if (!launchTime(attempt)) continue;
      try {
        await publishComment(state, api, repo, attempt, attempt.id === latest.id ? handoff : null, options, clock(), attempt.id === latest.id ? recoveryHold : null);
      } catch {
        state.updateProgress(attempt.id, { error: 'progress-update-failed' });
      }
    }
  }
  return { sync, async all() { for (const row of state.list()) await sync(row.number); } };
}

export function statusRepository(state, stateDir, requestedRepo) {
  const bound = state.get('sourceRepo');
  if (bound) {
    if (requestedRepo !== undefined && githubRepo(requestedRepo) !== bound) {
      throw new Error('Status repository does not match the journal');
    }
    return bound;
  }
  const saved = state.get('statusRepo');
  if (requestedRepo === undefined && !saved) return undefined;
  const repo = githubRepo(requestedRepo ?? saved);
  if (saved && repo !== saved) throw new Error('Status repository does not match the journal');
  const target = state.get('repo');
  const checkout = verifyTarget(target, [target], stateDir);
  const origin = git(checkout, ['config', '--local', '--get-all', 'remote.origin.url']);
  if (githubOrigin(origin) !== repo) throw new Error('Status repository does not match the saved checkout origin');
  return repo;
}

export async function recordHandoff(state, sourceRepo, number, pull, api = githubStatus) {
  const repo = githubRepo(sourceRepo);
  const task = state.task(number);
  if (task?.state !== 'done' || !state.githubProgress(number).some(launchTime)) {
    throw new Error('Handoff requires a completed, launched worker attempt');
  }
  const previous = state.githubStatusRows().find(row => row.number === number)?.pull;
  if (previous && previous !== pull) throw new Error('A different PR is already recorded for this handoff');
  const candidate = await api.pull(repo, pull);
  if (candidate.number !== pull || !matchesHandoff(candidate, task, repo)) {
    throw new Error('Expected an open PR from the recorded task branch into main in the same repository');
  }
  state.updateGithubStatus(number, { pull });
}
