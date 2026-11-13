import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findCodex, MODELS } from './codex.js';
import { execute, preview } from './controller.js';
import { pollGithubIssues } from './github.js';
import { plan } from './scheduler.js';
import { lease, State, stateDirectory } from './state.js';
import { removeCleanWorktree } from './worktrees.js';
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
      execute: { type: 'boolean' }, 'github-decisions': { type: 'boolean' },
      limit: { type: 'string', default: '1' },
      'timeout-seconds': { type: 'string', default: '900' },
      'confirm-process-exited': { type: 'boolean' }, help: { type: 'boolean' }
    }
  });
  const [command = 'run', argument, ...extra] = positionals;
  if (values.help) {
    console.log('Commands: run | poll | doctor | status | pause | stop | unpause | acknowledge N | cleanup N | retry-decision ID');
    console.log('Run defaults to dry-run. Use --queue FILE --state DIR --execute --limit N for real work.');
    console.log('Watch supervised merges with run --execute --queue FILE --watch-acceptance FILE --polls N.');
    console.log('Poll GitHub read-only with poll --repo OWNER/REPO --polls N --interval-seconds N.');
    console.log('Opt in to decision comments with run --execute --github-decisions and a reviewed GitHub queue.');
    return;
  }
  const withNumber = ['acknowledge', 'cleanup'].includes(command);
  const retryDecision = command === 'retry-decision';
  const validArgument = withNumber ? /^[1-9]\d*$/.test(argument ?? '') && Number.isSafeInteger(Number(argument))
    : retryDecision ? /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(argument ?? '')
      : argument === undefined;
  if (extra.length || !validArgument) {
    throw new Error('Unexpected command arguments. Use --help');
  }

  if (values['github-decisions'] && (command !== 'run' || !values.execute)) {
    throw new Error('--github-decisions requires a real run with --execute');
  }
  if (values['watch-acceptance'] !== undefined && (command !== 'run' || !values.execute || !values.queue)) {
    throw new Error('--watch-acceptance requires --execute and an explicit --queue');
  }
  if (values.repo && command !== 'poll') throw new Error('--repo is only used with poll');
  const polling = { polls: Number(values.polls), intervalMs: 1000 * Number(values['interval-seconds']) };
  if (command === 'poll') {
    if (values.execute) throw new Error('poll is read-only. Use run with a reviewed queue for execution');
    for await (const snapshot of pollGithubIssues(values.repo, polling)) print(snapshot);
    return;
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
        signal: abort.signal, decisionsEnabled: values['github-decisions'], readAcceptance, acceptancePath, ...polling
      });
      print(result);
      if (result.reason === 'interrupted-worker-needs-review' ||
          result.results.some(task => task.state === 'failed')) process.exitCode = 1;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    return;
  }

  if (!['status', 'pause', 'stop', 'unpause', 'acknowledge', 'cleanup', 'retry-decision'].includes(command)) {
    throw new Error('Unknown command. Use --help');
  }
  const path = resolve(values.state);
  if (command === 'status' && !existsSync(resolve(path, 'tasks.sqlite'))) {
    return print({ control: 'running', tasks: [] });
  }
  const stateDir = stateDirectory(path);
  const release = withNumber || retryDecision ? lease(stateDir) : () => {};
  let state;
  try {
    state = new State(stateDir);
    if (command === 'status') {
      const sourceRepo = state.get('sourceRepo');
      const decisions = state.decisionStatus();
      return print({ control: state.get('control') ?? 'running', ...(sourceRepo && { sourceRepo }),
        tasks: state.list(), ...(decisions.length && { decisions }) });
    }
    if (retryDecision) {
      state.retryDecision(argument);
      return print({ decision: argument, delivery: 'queued-for-reconciliation' });
    }
    if (command === 'acknowledge') {
      if (!values['confirm-process-exited']) throw new Error('Verify the process tree exited and pass --confirm-process-exited');
      state.recover();
      const number = Number(argument);
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
    state.set('control', control);
    print({ control });
  } finally {
    try { state?.close(); } finally { release(); }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
