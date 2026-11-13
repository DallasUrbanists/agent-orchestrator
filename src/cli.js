import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkSupervisedMerge } from './merge-preflight.js';
import { findCodex, MODELS } from './codex.js';
import { execute, preview } from './controller.js';
import { recordHandoff, statusIssueNumbers, statusPublisher, statusRepository } from './issue-status.js';
import { pollGithubIssues } from './github.js';
import { plan } from './scheduler.js';
import { hasJournal, lease, State, stateDirectory } from './state.js';
import { removeCleanWorktree } from './worktrees.js';
import { backupJournal, restoreJournal } from './backup.js';
import { assertWorkerPidAbsent } from './recovery.js';

function print(value) { console.log(JSON.stringify(value, null, 2)); }

function diagnostic(executable, args, includeOutput = true) {
  const result = spawnSync(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 5000 });
  return { ok: result.status === 0, ...(result.status === 0 && includeOutput
    ? { version: result.stdout.trim().split(/\r?\n/)[0] } : {}) };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      queue: { type: 'string' }, 'watch-acceptance': { type: 'string' }, state: { type: 'string', default: './state' },
      repo: { type: 'string' }, polls: { type: 'string', default: '1' },
      'interval-seconds': { type: 'string', default: '15' },
      execute: { type: 'boolean' }, 'adopt-local-intake': { type: 'boolean' }, continuous: { type: 'boolean' }, 'github-decisions': { type: 'boolean' },
      'github-status': { type: 'boolean' }, pr: { type: 'string' }, 'merge-evidence': { type: 'string' },
      limit: { type: 'string', default: '1' },
      'timeout-seconds': { type: 'string', default: '900' }, 'final-host-verification': { type: 'string' },
      'confirm-process-exited': { type: 'boolean' }, 'confirm-reconciled': { type: 'boolean' }, help: { type: 'boolean' }
    }
  });
  const [command = 'run', argument, ...extra] = positionals;
  let finalHostVerification;
  if (values['final-host-verification'] !== undefined) {
    const match = /^([1-9]\d*):([1-9]\d*)$/.exec(values['final-host-verification']);
    if (command !== 'run' || !values.execute || !match) {
      throw new Error('Final host verification requires run --execute --final-host-verification ISSUE:ATTEMPT');
    }
    finalHostVerification = { number: Number(match[1]), afterAttempt: Number(match[2]) };
  }
  if (values.help) {
    console.log('Commands: run | poll | doctor | status | attempts | pause | stop | unpause | acknowledge N | cleanup N | retry-decision ID | backup | restore FILE | sync-status [N] [--repo OWNER/REPO] | handoff N --pr N | check-merge N --merge-evidence FILE');
    console.log('Opt in to status labels and progress comments with run --execute --github-status.');
    console.log('Run defaults to dry-run. Use --queue FILE --state DIR --execute --limit N for real work.');
    console.log('Authorize one host-only verification after exhaustion with --final-host-verification ISSUE:ATTEMPT.');
    console.log('For GitHub intake, configure githubIntake.coordinatorId in the queue file.');
    console.log('Watch supervised merges with run --execute --queue FILE --watch-acceptance FILE --polls N or --continuous.');
    console.log('Poll GitHub read-only with poll --repo OWNER/REPO --polls N --interval-seconds N.');
    console.log('Opt in to decision comments with run --execute --github-decisions and a reviewed GitHub queue.');
    return;
  }
  if (values['adopt-local-intake'] && (command !== 'run' || !values.execute)) {
    throw new Error('--adopt-local-intake requires a real run with --execute');
  }
  if (values.continuous && (command !== 'run' || !values.execute)) {
    throw new Error('--continuous requires a real run with --execute');
  }
  const publish = command === 'sync-status' || command === 'handoff';
  const withNumber = ['acknowledge', 'cleanup', 'handoff', 'check-merge'].includes(command) ||
    (command === 'sync-status' && argument !== undefined);
  const retryDecision = command === 'retry-decision';
  const validArgument = withNumber ? /^[1-9]\d*$/.test(argument ?? '') && Number.isSafeInteger(Number(argument))
    : retryDecision ? /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(argument ?? '')
      : command === 'restore' ? argument !== undefined : argument === undefined;
  if (extra.length || !validArgument) {
    throw new Error('Unexpected command arguments. Use --help');
  }

  if (command === 'check-merge' ? !values['merge-evidence'] : values['merge-evidence'] !== undefined) {
    throw new Error('Only check-merge accepts and requires --merge-evidence FILE');
  }
  if (values['github-status'] && (command !== 'run' || !values.execute)) {
    throw new Error('--github-status requires a real run with --execute');
  }
  if (command === 'handoff' ? !/^[1-9]\d*$/.test(values.pr ?? '') || !Number.isSafeInteger(Number(values.pr)) : values.pr !== undefined) {
    throw new Error('Only handoff accepts and requires --pr N');
  }
  if (values['github-decisions'] && (command !== 'run' || !values.execute)) {
    throw new Error('--github-decisions requires a real run with --execute');
  }
  if (values['watch-acceptance'] !== undefined && (command !== 'run' || !values.execute || !values.queue)) {
    throw new Error('--watch-acceptance requires --execute and an explicit --queue');
  }
  if (values.repo !== undefined && command !== 'poll' && !(command === 'sync-status' && withNumber)) {
    throw new Error('--repo is only used with poll or single-issue sync-status');
  }
  const polling = { polls: Number(values.polls), intervalMs: 1000 * Number(values['interval-seconds']) };
  if (command === 'poll') {
    if (values.execute) throw new Error('poll is read-only. Use run with a reviewed queue for execution');
    for await (const snapshot of pollGithubIssues(values.repo, polling)) print(snapshot);
    return;
  }

  if (command === 'check-merge') {
    if (values.execute) throw new Error('check-merge is read-only');
    const config = JSON.parse(readFileSync(values['merge-evidence'], 'utf8').replace(/^\uFEFF/, ''));
    const result = await checkSupervisedMerge(config, Number(argument));
    if (!result.eligibleAtObservation) process.exitCode = 1;
    return print(result);
  }

  if (command === 'doctor') {
    let codex;
    try { codex = findCodex(); } catch { /* Report missing executable. */ }
    return print({ node: process.version, platform: process.platform, git: diagnostic('git', ['--version']),
      gh: diagnostic('gh', ['--version']), codex: codex ? diagnostic(codex, ['--version']) : { ok: false },
      login: codex ? diagnostic(codex, ['login', 'status'], false) : { ok: false }, models: MODELS });
  }

  if (command === 'run') {
    const queueFile = values.queue ?? fileURLToPath(new URL('../fixtures/issues.json', import.meta.url));
    const data = JSON.parse(readFileSync(queueFile, 'utf8').replace(/^\uFEFF/, ''));
    if (!values.execute) {
      return print(Array.isArray(data) ? { mode: 'dry-run', ...plan(data) } : await preview(data, resolve(values.state)));
    }
    if (!values.queue) throw new Error('Real execution requires an explicit local queue');
    const executable = findCodex();
    const acceptancePath = values['watch-acceptance'] === undefined ? null : realpathSync(resolve(values['watch-acceptance']));
    const readAcceptance = acceptancePath ? () => JSON.parse(readFileSync(acceptancePath, 'utf8').replace(/^\uFEFF/, '')) : undefined;
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      const result = await execute(data, resolve(values.state), {
        executable, limit: Number(values.limit), timeoutMs: 1000 * Number(values['timeout-seconds']),
        signal: abort.signal, decisionsEnabled: values['github-decisions'], publishStatus: values['github-status'],
        readAcceptance, acceptancePath, finalHostVerification, continuous: values.continuous,
        adoptLocalIntake: values['adopt-local-intake'], ...polling
      });
      print(result);
      if (['interrupted-worker-needs-review', 'restored-state-needs-reconciliation'].includes(result.reason) ||
          result.results.some(task => task.state === 'failed')) process.exitCode = 1;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    return;
  }

  if (command === 'backup' || command === 'restore') {
    const stateDir = realpathSync(resolve(values.state));
    return print(command === 'backup'
      ? { snapshot: await backupJournal(stateDir) }
      : { restored: restoreJournal(stateDir, argument), control: 'pause', reconciliationRequired: true });
  }

  if (!['status', 'attempts', 'pause', 'stop', 'unpause', 'acknowledge', 'cleanup', 'retry-decision', 'sync-status', 'handoff'].includes(command)) {
    throw new Error('Unknown command. Use --help');
  }
  const path = resolve(values.state);
  if (command === 'attempts' && !hasJournal(path)) return print({ attempts: [] });
  if (command === 'status' && !hasJournal(path)) {
    return print({ control: 'running', tasks: [] });
  }
  if (publish && !hasJournal(path)) throw new Error('Status publishing requires an existing state journal');
  const stateDir = stateDirectory(path);
  const release = withNumber || retryDecision || publish || (command === 'unpause' && values['confirm-reconciled'])
    ? lease(stateDir) : () => {};
  let state;
  try {
    state = new State(stateDir);
    if (publish) {
      if (state.get('restoreHold') === 'true') throw new Error('Status publishing requires reconciled state');
      const sourceRepo = statusRepository(state, stateDir, values.repo);
      if (!sourceRepo) throw new Error('Status publishing requires a saved GitHub repository or single-issue sync-status with --repo');
      const number = Number(argument);
      const numbers = statusIssueNumbers(state);
      if (numbers && argument !== undefined && !numbers.has(number)) {
        throw new Error('Issue is outside the saved reporting queue');
      }
      if (argument !== undefined && !state.task(number)) {
        if (command === 'handoff') throw new Error('Handoff requires an existing task');
        return print({ number, status: 'unclaimed' });
      }
      if (!state.get('sourceRepo') && (argument === undefined ? state.list() : [state.task(number)])
        .some(task => task.state === 'running')) {
        throw new Error('Review the running claim in the original journal before publishing');
      }
      if (state.get('sourceRepo')) state.recover();
      const publisher = statusPublisher(state, sourceRepo, { numbers });
      if (command === 'handoff') await recordHandoff(state, sourceRepo, number, Number(values.pr));
      if (argument === undefined) await publisher.all();
      else await publisher.sync(number);
      const updates = state.githubStatusRows().filter(row => (!numbers || numbers.has(row.number)) &&
        (argument === undefined || row.number === number));
      const progress = state.list().filter(row => (!numbers || numbers.has(row.number)) &&
        (argument === undefined || row.number === number))
        .flatMap(row => state.githubProgress(row.number).map(({ id, comment, publication_error }) =>
          ({ attempt: id, comment, error: publication_error })));
      if (updates.some(row => row.error) || progress.some(row => row.error)) process.exitCode = 1;
      return print({ updates, progress });
    }
    if (command === 'status') {
      const sourceRepo = state.get('sourceRepo');
      const decisions = state.decisionStatus();
      const intakeClaims = state.intakeClaims();
      const githubUpdates = state.githubStatusRows();
      const handoffs = state.handoffs();
      const handoffHolds = state.list().filter(row => state.get('publicationHold:' + row.number)).map(row => row.number);
      const recovery = state.recoveryRows().map(({ scope, ...row }) => row);
      return print({ control: state.get('control') ?? 'running', ...(sourceRepo && { sourceRepo }),
        tasks: state.list(), ...(decisions.length && { decisions }), ...(intakeClaims.length && { intakeClaims }), ...(githubUpdates.length && { githubUpdates }), ...(handoffs.length && { handoffs }), ...(handoffHolds.length && { handoffHolds }), ...(recovery.length && { recovery }),
        ...(state.get('restoreHold') === 'true' && { reconciliationRequired: true }) });
    }
    if (command === 'attempts') {
      const progress = state.list().flatMap(row => state.githubProgress(row.number)
        .filter(attempt => attempt.comment || attempt.publication_error)
        .map(({ id, comment, publication_error }) => ({ attempt: id, comment, error: publication_error })));
      return print({ attempts: state.attempts(), ...(progress.length && { progress }) });
    }
    if (retryDecision) {
      state.retryDecision(argument);
      return print({ decision: argument, delivery: 'queued-for-reconciliation' });
    }
    if (command === 'acknowledge') {
      if (!values['confirm-process-exited']) throw new Error('Verify the process tree exited and pass --confirm-process-exited');
      state.recover();
      const number = Number(argument);
      const repair = JSON.parse(state.get('activePullRepair') || 'null');
      if (repair?.pull === number) {
        assertWorkerPidAbsent(repair.pid ?? null);
        state.set('activePullRepair', '');
        return print({ acknowledgedRepair: number });
      }
      const task = state.task(number);
      if (task?.state === 'interrupted') assertWorkerPidAbsent(task.pid);
      state.acknowledge(number);
      return print({ acknowledged: Number(argument) });
    }
    if (command === 'cleanup') {
      const task = state.task(Number(argument));
      if (task?.state !== 'done' || task.cleaned) throw new Error('Cleanup requires a completed task with a worktree');
      removeCleanWorktree(task.target, { path: task.worktree, branch: task.branch });
      state.cleaned(task.number);
      return print({ cleaned: task.number, retainedBranch: task.branch });
    }
    const control = command === 'unpause' ? 'running' : command;
    if (command === 'unpause' && state.get('restoreHold') === 'true') {
      if (!values['confirm-reconciled']) {
        throw new Error('Reconcile restored claims, workers, and GitHub actions before passing --confirm-reconciled');
      }
      state.transaction(() => {
        state.set('control', control);
        state.set('restoreHold', 'false');
      });
    } else state.set('control', control);
    print({ control });
  } finally {
    try { state?.close(); } finally { release(); }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
