import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { githubHandoff, githubOrigin, githubRepo } from './github.js';
import { git, verifyResumeWorktree } from './worktrees.js';

const id = number => Number.isSafeInteger(number) && number > 0;
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const lines = value => value.split('\0').filter(Boolean);
const scopePath = /^(?:[a-z0-9_@.+-]+\/)*[a-z0-9_@.+-]+\/?$/i;
const reserved = /(^|\/)(?:\.git|\.env[^/]*|\.codex|\.agents|\.aws|\.npmrc)(?:\/|$)/i;

export function publicationPolicy(config) {
  const repo = githubRepo(config?.repo);
  if (!Array.isArray(config.issues) || !config.issues.length) throw new Error('Publication requires reviewed issue scopes');
  const issues = new Map();
  for (const entry of config.issues) {
    if (!id(entry?.number) || issues.has(entry.number) || !Array.isArray(entry.paths) || !entry.paths.length ||
        entry.paths.some(path => typeof path !== 'string' || !scopePath.test(path) || reserved.test(path) ||
          path.split('/').some(part => part === '.' || part === '..'))) throw new Error('Invalid publication issue scope');
    if (entry.verified !== undefined && (!oid(entry.verified?.base) || !oid(entry.verified?.tree) ||
        typeof entry.verified.summary !== 'string' || !entry.verified.summary.trim() || entry.verified.summary.length > 3000)) {
      throw new Error('Saved verification requires a base, tree, and reviewed summary');
    }
    issues.set(entry.number, entry);
  }
  return { repo, issues };
}

export function publicationOrigin(target, repo) {
  for (const args of [
    ['config', '--local', '--get-all', 'remote.origin.url'],
    ['remote', 'get-url', '--push', '--all', 'origin'],
    ['remote', 'get-url', '--all', 'origin']
  ]) {
    if (githubOrigin(git(target, args)) !== repo) throw new Error('Publication requires a single matching GitHub origin');
  }
}

function assertWorktree(target, stateDir, task) {
  const path = join(stateDir, 'worktrees', 'task-' + task.number);
  const branches = ['orchestrator/task-', 'orchestrator/github-issue-'].map(prefix => prefix + task.number);
  if (relative(realpathSync(join(stateDir, 'worktrees')), join(stateDir, 'worktrees')) || !branches.includes(task.branch)) {
    throw new Error('Unexpected publication worktree');
  }
  verifyResumeWorktree(target, { path, branch: task.branch }, task);
  return path;
}

export function permitted(path, scope) {
  return !reserved.test(path) && !/[\0-\x1f\x7f\\:]/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..') &&
    scope.some(entry => entry.endsWith('/') ? path.startsWith(entry) : path === entry);
}

export function assertRegularPath(cwd, path) {
  const file = join(cwd, path);
  try {
    if (!lstatSync(file).isFile() || relative(file, realpathSync(file))) {
      throw new Error('Publication requires in-scope regular-file changes');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function captureVerifiedTree(target, stateDir, task, scope, base, commit) {
  const cwd = assertWorktree(target, stateDir, task);
  const head = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!oid(base) || (head !== base && head !== commit)) throw new Error('Unexpected task branch head');
  const index = git(cwd, ['write-tree']);
  const headTree = git(cwd, ['rev-parse', head + '^{tree}']);
  if (index !== headTree && !(commit && head === commit && index === git(cwd, ['rev-parse', base + '^{tree}']))) {
    throw new Error('Publication requires an untouched task index');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'orchestrator-publication-'));
  try {
    const tempIndex = join(scratch, 'index');
    git(cwd, ['read-tree', base], tempIndex);
    const tracked = lines(git(cwd, ['diff', '--name-only', '--no-renames', '-z', base], undefined, true));
    // Include paths absent from the verified parent even after updating the branch and index.
    const committed = head === base ? [] : lines(git(cwd, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', base, head], undefined, true));
    const added = lines(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], tempIndex, true));
    const paths = [...new Set([...tracked, ...added, ...committed])];
    if (paths.some(path => !permitted(path, scope))) throw new Error('Worktree contains changes outside the reviewed scope');
    for (const path of paths) assertRegularPath(cwd, path);
    for (const path of paths) git(cwd, ['add', '-A', '--', path], tempIndex);
    const tree = git(cwd, ['write-tree'], tempIndex);
    const changes = lines(git(cwd, ['diff-tree', '-r', '--raw', '--no-renames', '-z', base, tree], tempIndex, true));
    if (!changes.length || changes.length % 2 || changes.some((value, i) => i % 2
      ? !permitted(value, scope)
      : !/^:(?:000000|100644|100755) (?:000000|100644|100755) /.test(value))) {
      throw new Error('Publication requires in-scope regular-file changes');
    }
    return { cwd, head, tree };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function marker(number, commit) {
  return '<!-- orchestrator-handoff:' + number + ':' + commit + ' -->';
}

async function ensureLink(state, api, repo, number, body, options, marker = body.split('\n')[0]) {
  const key = 'handoff-link:' + repo + ':' + number + ':' + marker;
  const pending = state.get(key);
  const actor = await api.viewer(options);
  if (!id(actor) || (pending && pending !== String(actor))) throw new Error('Handoff comment publisher changed');
  const matches = (await api.comments(repo, number, options)).filter(comment =>
    comment?.user?.id === actor && comment.body === body && id(comment.id));
  if (matches.length > 1) throw new Error('Ambiguous handoff comment');
  if (matches.length) return;
  if (pending) throw new Error('Handoff comment delivery is unconfirmed');
  state.set(key, String(actor));
  try {
    const posted = await api.post(repo, number, body, options);
    if (!id(posted?.id) || posted.user?.id !== actor || posted.body !== body) throw new Error('Unconfirmed handoff comment');
  }
  catch (error) {
    if ([401, 403, 404, 422, 429].includes(error.status)) state.set(key, '');
    throw error;
  }
}

export async function requestCodexReview(state, repo, number, branch, head, options, api = githubHandoff) {
  if (!id(number) || !oid(head)) return;
  const marker = 'codex-review:' + head;
  const key = marker + ':' + repo + ':' + number;
  if (state.get(key)) return;
  const pulls = await api.pulls(repo, branch, options);
  if (!pulls.some(pull => pull.number === number && pull.state === 'open' &&
    pull.head?.ref === branch && pull.head?.sha === head && pull.head?.repo?.full_name?.toLowerCase() === repo &&
    pull.base?.ref === 'main' && pull.base?.repo?.full_name?.toLowerCase() === repo)) return;
  if (options.signal?.aborted || ['pause', 'stop'].includes(state.get('control'))) return;
  await ensureLink(state, api, repo, number, '@codex review\n\n<!-- ' + marker + ' -->', options, marker);
  state.set(key, 'requested');
}

export async function publishVerified({ state, stateDir, target, policy, number, signal,
  api = githubHandoff, push = pushTask, authorize }) {
  const { repo, issues } = policy;
  const entry = issues.get(number);
  const task = state.task(number);
  if (task?.state !== 'done' || !entry || task.cleaned || signal?.aborted) return null;
  async function verifyApproval() {
    if (!authorize || await authorize()) return;
    throw Object.assign(new Error('Publication requires the original approved intake revision'), {
      code: 'intake-publication-scope-no-longer-approved'
    });
  }
  await verifyApproval();
  publicationOrigin(target, repo);
  const options = { signal };
  const issue = await api.issue(repo, number, options);
  if (issue?.number !== number || issue.state !== 'open' || issue.pull_request ||
      issue.html_url?.toLowerCase() !== 'https://github.com/' + repo + '/issues/' + number) {
    throw new Error('Publication requires the matching open issue');
  }
  let receipt = state.handoff(number);
  if (!receipt && entry.verified) {
    const { base, tree, summary } = entry.verified;
    const captured = captureVerifiedTree(target, stateDir, task, entry.paths, base);
    if (captured.tree !== tree) throw new Error('Saved worktree no longer matches reviewed verification');
    state.recordVerification(number, { repo, base, tree, evidence: summary });
    receipt = state.handoff(number);
  }
  if (!receipt) return null;
  if (receipt.repo !== repo) throw new Error('Publication receipt belongs to another repository');
  if (receipt.linked) return 'https://github.com/' + repo + '/pull/' + receipt.pull;
  const { base, tree, evidence } = receipt;
  const current = captureVerifiedTree(target, stateDir, task, entry.paths, base, receipt.commit_sha);
  if (current.tree !== tree) throw new Error('Verified worktree changed before publication');
  publicationOrigin(current.cwd, repo);
  if (signal?.aborted || ['pause', 'stop'].includes(state.get('control'))) return null;
  let commit = receipt.commit_sha;
  if (!commit) {
    commit = git(current.cwd, ['-c', 'user.name=Agent Orchestrator', '-c',
      'user.email=orchestrator@users.noreply.github.com', '-c', 'commit.gpgsign=false',
      'commit-tree', tree, '-p', base, '-m', 'Implement issue #' + number]);
    if (!oid(commit)) throw new Error('Could not create the verified commit');
    state.updateHandoff(number, { commit });
  }
  if (git(current.cwd, ['rev-parse', commit + '^{tree}']) !== tree ||
      git(current.cwd, ['rev-list', '--parents', '-n', '1', commit]) !== commit + ' ' + base) {
    throw new Error('Publication commit no longer matches the verified tree and parent');
  }
  if (current.head !== commit) git(current.cwd, ['update-ref', 'refs/heads/' + task.branch, commit, base]);
  git(current.cwd, ['read-tree', commit]);

  if (signal?.aborted || ['pause', 'stop'].includes(state.get('control'))) return null;
  const notice = marker(number, commit);
  const evidenceBody = [notice, 'Related issue: #' + number, '', 'Verified commit: ' + commit, '',
    '## Verification evidence', '', evidence].join('\n');
  const matches = (await api.pulls(repo, task.branch, options)).filter(pull =>
    pull.head?.ref === task.branch && pull.head?.repo?.full_name?.toLowerCase() === repo &&
    pull.base?.ref === 'main' && pull.base?.repo?.full_name?.toLowerCase() === repo);
  if (matches.length > 1 || (receipt.pull && matches[0]?.number !== receipt.pull)) {
    throw new Error('Ambiguous or missing task pull request');
  }
  if (signal?.aborted || ['pause', 'stop'].includes(state.get('control'))) return null;
  const valid = pull => id(pull?.number) && pull.state === 'open' && pull.head?.sha === commit &&
    pull.head?.ref === task.branch && pull.head?.repo?.full_name?.toLowerCase() === repo &&
    pull.base?.ref === 'main' && pull.base?.repo?.full_name?.toLowerCase() === repo &&
    pull.html_url?.toLowerCase() === 'https://github.com/' + repo + '/pull/' + pull.number;
  let pull = matches[0];
  if (pull && !valid(pull)) throw new Error('Existing pull request does not match the open verified handoff');
  if (!pull) {
    await verifyApproval();
    if (signal?.aborted || ['pause', 'stop'].includes(state.get('control'))) return null;
    await push(current.cwd, task.branch, commit);
    await verifyApproval();
    if (signal?.aborted || ['pause', 'stop'].includes(state.get('control'))) return null;
    pull = await api.create(repo, { branch: task.branch, title: 'Implement issue #' + number, body: evidenceBody }, options);
  }
  if (!valid(pull)) {
    throw new Error('Existing pull request does not match the open verified handoff');
  }
  state.updateHandoff(number, { pull: pull.number });
  await verifyApproval();
  if (signal?.aborted || ['pause', 'stop'].includes(state.get('control'))) return null;
  if (pull.body !== evidenceBody) await ensureLink(state, api, repo, pull.number, evidenceBody, options);
  if (signal?.aborted || ['pause', 'stop'].includes(state.get('control'))) return null;
  if (pull.body !== evidenceBody) await verifyApproval();
  if (signal?.aborted || ['pause', 'stop'].includes(state.get('control'))) return null;
  await ensureLink(state, api, repo, number, notice + '\nVerified work is ready for review: ' + pull.html_url, options);
  state.transaction(() => {
    state.updateGithubStatus(number, { pull: pull.number });
    state.updateHandoff(number, { linked: 1 });
  });
  return pull.html_url;
}

function pushTask(cwd, branch, commit) {
  const ref = 'refs/heads/' + branch;
  const found = git(cwd, ['ls-remote', '--refs', 'origin', ref]);
  if (found === commit + '\t' + ref) return;
  if (found) throw new Error('Task branch already exists remotely at a different commit');
  git(cwd, ['-c', 'push.followTags=false', 'push', '--no-recurse-submodules', '--no-follow-tags', 'origin', commit + ':' + ref]);
}
