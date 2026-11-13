import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { findCodex, MODELS, runCodex } from '../src/codex.js';
import { execute } from '../src/controller.js';
import { normalizeIssues } from '../src/github.js';
import { stateDirectory, State } from '../src/state.js';
import { git } from '../src/worktrees.js';

const live = process.env.ORCHESTRATOR_LIVE_TEST === '1';
const chrome = process.env.ORCHESTRATOR_TEST_CHROME;

function disposable(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'orchestrator-live-'));
  t.diagnostic('Retained disposable workspace: ' + scratch);
  const repo = join(scratch, 'target');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  writeFileSync(join(repo, 'terra.txt'), 'seed\n');
  writeFileSync(join(repo, 'sol.txt'), 'seed\n');
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=Orchestrator Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'Seed disposable fixture']);
  return { scratch, repo, stateDir: stateDirectory(join(scratch, 'run')) };
}

test('one live controller dispatches a dependent task from supervised merged main', {
  skip: !live || process.platform !== 'win32', timeout: 290000
}, async t => {
  const { scratch, repo, stateDir } = disposable(t);
  const queuePath = join(scratch, 'reviewed-queue.json');
  const receipts = join(scratch, 'acceptance.json');
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  writeFileSync(receipts, '[]');
  writeFileSync(queuePath, JSON.stringify({ target: repo, allowedRepos: [repo],
    acceptedPrerequisites: [], issues: [
      { number: 1, model: 'terra', state: 'ready', dependencies: [],
        prompt: 'Set terra.txt to exactly accepted-first and report done. Leave all other files alone.' },
      { number: 2, model: 'sol', state: 'ready', dependencies: [1],
        prompt: 'Read terra.txt. If it contains accepted-first, set sol.txt to exactly observed-accepted-first and report done.' }
    ] }));
  const seed = git(repo, ['rev-parse', 'HEAD']);
  const controller = spawn(process.execPath, [cli, 'run', '--queue', queuePath, '--state', stateDir, '--execute',
    '--watch-acceptance', receipts, '--polls', '60', '--interval-seconds', '1', '--limit', '2', '--timeout-seconds', '120'],
  { cwd: scratch, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  controller.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  controller.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = once(controller, 'close');
  function task(number) {
    if (!existsSync(join(stateDir, 'tasks.sqlite'))) return undefined;
    const state = new State(stateDir, { readOnly: true });
    try { return state.task(number); } finally { state.close(); }
  }
  function assertWatching() {
    assert.equal(controller.exitCode, null, stderr || stdout);
    assert.equal(controller.signalCode, null);
    assert.equal(task(2), undefined, 'dependent claimed before acceptance');
  }
  try {
    for (let tick = 0; tick < 1200 && task(1)?.state !== 'done'; tick++) {
      assertWatching();
      await delay(100);
    }
    const first = task(1);
    assert.equal(first?.state, 'done', stderr || stdout);
    assert.equal(readFileSync(join(first.worktree, 'terra.txt'), 'utf8').trim(), 'accepted-first');
    assert.equal(git(first.worktree, ['rev-parse', 'HEAD']), seed);
    await delay(1200);
    assertWatching();

    // The supervising coordinator, not the controller, commits and merges.
    git(first.worktree, ['add', 'terra.txt']);
    git(first.worktree, ['-c', 'user.name=Supervisor', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'Accept fixture issue 1']);
    git(repo, ['-c', 'user.name=Supervisor', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', first.branch]);
    const merged = git(repo, ['rev-parse', 'HEAD']);
    assert.notEqual(merged, seed);
    await delay(1200);
    assertWatching();

    const nextReceipts = receipts + '.next';
    writeFileSync(nextReceipts, JSON.stringify([{ number: 1, commit: merged }]));
    renameSync(nextReceipts, receipts);
    const [code] = await exited;
    assert.equal(code, 0, stderr || stdout);
    const report = JSON.parse(stdout);
    assert.deepEqual(report.results.map(row => [row.number, row.state]), [[1, 'done'], [2, 'done']]);
    const second = task(2);
    assert.equal(git(second.worktree, ['rev-parse', 'HEAD']), merged);
    assert.equal(readFileSync(join(second.worktree, 'sol.txt'), 'utf8').trim(), 'observed-accepted-first');
    t.diagnostic(JSON.stringify({ controllerPid: controller.pid, seed, merged, dependentBase: merged }));
  } finally {
    if (controller.exitCode === null && controller.signalCode === null) {
      spawnSync(process.execPath, [cli, 'stop', '--state', stateDir], { windowsHide: true, timeout: 5000 });
      await exited;
    }
  }
});

test('blocks, runs independent work, and resumes after an authorized fixture reply', {
  skip: !live, timeout: 470000
}, async t => {
  const { scratch, repo, stateDir } = disposable(t);
  const outside = join(scratch, 'outside.txt');
  writeFileSync(outside, 'outside-sentinel');
  writeFileSync(join(repo, 'probe.cjs'), [
    "const { realpathSync, writeFileSync } = require('node:fs');",
    "const { tmpdir } = require('node:os');",
    "const { dirname, relative } = require('node:path');",
    "const scratch = realpathSync(process.env.ORCHESTRATOR_WORKER_TEMP);",
    "if (relative(realpathSync(process.cwd()), dirname(scratch)) || relative(realpathSync(tmpdir()), scratch)) throw Error('Unexpected scratch');",
    "writeFileSync(scratch + '/scratch-probe.txt', 'ok');",
    "writeFileSync('scratch-path.txt', scratch);",
    "try { writeFileSync(" + JSON.stringify(outside) + ", 'SANDBOX-PROBE'); process.exitCode = 90; }",
    "catch (error) {",
    "  if (!['EPERM', 'EACCES'].includes(error.code)) throw error;",
    "  writeFileSync('probe-result.txt', error.code);",
    "}"
  ].join('\n'));
  git(repo, ['add', 'probe.cjs']);
  git(repo, ['-c', 'user.name=Orchestrator Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'Add scoped sandbox probe']);
  const issues = ['terra', 'sol'].map((model, index) => ({
    number: index + 1,
    ...(!index && { decisions: [{
      key: 'confirm-fixture', question: 'Should the fixture continue?',
      choices: [
        { id: 'continue', label: 'Continue', instruction: 'Verify terra.txt and finish the fixture task.' },
        { id: 'leave', label: 'Leave as-is', instruction: 'Leave the existing edits and stop.' }
      ]
    }] }),
    prompt: 'Set ' + model + '.txt to exactly the text integrated-' + model +
      ' (a trailing newline is allowed). Read it back. ' +
      (index ? '' : 'If this prompt includes an Authorized choice section, leave existing files unchanged and report done. ' +
        'Otherwise run the committed disposable sandbox probe using node probe.cjs once. ' +
        'It only attempts a write to a synthetic sentinel for this integration test. ' +
        'After the file edit and probe, return blocked with decisionKey confirm-fixture. ') +
      'Return the required structured outcome.'
  }));
  const sourceRepo = 'fixture/disposable-issues';
  git(repo, ['remote', 'add', 'origin', 'https://github.com/' + sourceRepo + '.git']);
  const metadata = ['terra', 'sol', 'terra'].map((model, index) => ({
    number: index + 1,
    title: 'Fixture issue ' + (index + 1),
    state: 'open',
    body: '',
    labels: [{ name: 'agent:ready' }, { name: 'model:' + model }]
  }));
  const queue = { target: repo, allowedRepos: [repo], sourceRepo, issues, authorizedResponders: [101] };
  const executable = findCodex();
  let reads = 0;
  const readIssues = async repoName => {
    assert.equal(repoName, sourceRepo);
    reads++;
    return normalizeIssues([reads === 1 ? [] : metadata]);
  };
  const timestamp = '2026-11-11T12:00:00Z';
  let posted;
  let posts = 0;
  const decisionApi = {
    async viewer() { return 100; },
    async post(_repo, number, body) {
      assert.equal(number, 1);
      posts++;
      posted = { id: 10, user: { id: 100, type: 'User' }, body, created_at: timestamp };
      return posted;
    },
    async comments() {
      if (!posted) return [];
      if (reads < 4) return [posted];
      const id = /agent-orchestrator-decision:([a-f0-9-]+)/.exec(posted.body)[1];
      return [posted, { id: 11, user: { id: 101, type: 'User' }, created_at: timestamp, updated_at: timestamp,
        body: '/orchestrator decide ' + id + ' continue' }];
    }
  };
  const options = { executable, limit: 4, timeoutMs: 140000, polls: 2, intervalMs: 10, readIssues,
    decisionsEnabled: true, decisionApi };
  const result = await execute(queue, stateDir, options);
  const store = new State(stateDir);
  let rows, attempts;
  try {
    assert.equal(store.get('sourceRepo'), sourceRepo);
    rows = store.list();
    attempts = store.attempts();
    const [decision] = store.decisionStatus();
    assert.equal(decision.responder_id, 101);
    assert.equal(decision.choice, 'continue');
    assert.ok(decision.consumed);
  } finally { store.close(); }
  t.diagnostic(JSON.stringify(result));
  for (const row of rows) {
    t.diagnostic(JSON.stringify({ model: row.model, state: row.state, detail: row.detail,
      exit: row.exit_code, thread: row.session, log: row.log }));
  }
  assert.deepEqual(result.results.map(item => [item.number, item.state]), [[1, 'blocked'], [2, 'done'], [1, 'done']]);
  assert.equal(posts, 1);
  assert.equal(result.results[2].resumedFrom, result.results[0].decision);
  assert.equal(rows[0].retries, 1);
  assert.deepEqual(attempts.map(item => [item.number, item.state]), [[1, 'blocked'], [2, 'done'], [1, 'done']]);
  assert.equal(attempts[2].decision, result.results[2].resumedFrom);
  assert.equal(attempts[2].session, rows[0].session);
  assert.equal(new Set(attempts.map(item => item.session)).size, 3);
  assert.equal(result.reason, 'no-eligible-work');
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].worktree, rows[1].worktree);
  for (const [index, row] of rows.entries()) {
    const model = ['terra', 'sol'][index];
    assert.equal(row.model, MODELS[model]);
    assert.equal(row.exit_code, 0);
    assert.ok(row.session);
    assert.equal(readFileSync(join(row.worktree, model + '.txt'), 'utf8').trim(), 'integrated-' + model);
    assert.equal(readFileSync(join(repo, model + '.txt'), 'utf8').trim(), 'seed');
    assert.ok(existsSync(row.log));
  }
  assert.equal(readFileSync(outside, 'utf8'), 'outside-sentinel', 'sandbox allowed a sibling Temp write');
  const initialScratch = readFileSync(join(rows[0].worktree, 'scratch-path.txt'), 'utf8');
  assert.equal(existsSync(initialScratch), false, 'worker scratch was not cleaned up');
  assert.match(readFileSync(join(rows[0].worktree, 'probe-result.txt'), 'utf8'), /^(EPERM|EACCES)$/);
  const restart = await execute(queue, stateDir, options,
    () => assert.fail('restart dispatched a claimed or unapproved task'));
  assert.deepEqual(restart, { reason: 'no-eligible-work', results: [] });
});

test('Chromium uses worktree-local scratch and loads a loopback page inside a Windows worker', {
  skip: !live || process.platform !== 'win32' || !chrome, timeout: 150000
}, async t => {
  const { repo, stateDir } = disposable(t);
  const probe = new URL('./chromium-probe.cjs', import.meta.url);
  writeFileSync(join(repo, 'chromium-probe.cjs'), readFileSync(probe));
  git(repo, ['add', 'chromium-probe.cjs']);
  git(repo, ['-c', 'user.name=Orchestrator Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'Add Chromium fixture']);
  const issues = [{
    number: 1, model: 'terra', state: 'ready', dependencies: [],
    prompt: 'Run this committed synthetic browser probe exactly once using Node: node chromium-probe.cjs ' +
      JSON.stringify(resolve(chrome)) + '. Do not edit the script or create its result file yourself. ' +
      'Report done only if the probe exits successfully. Otherwise report blocked with a brief error.'
  }];
  const result = await execute({ target: repo, allowedRepos: [repo], issues }, stateDir,
    { executable: findCodex(), limit: 1, timeoutMs: 120000 });
  const worktree = join(stateDir, 'worktrees', 'task-1');
  const report = JSON.parse(readFileSync(join(worktree, 'chromium-result.json'), 'utf8'));
  t.diagnostic(JSON.stringify(report));
  assert.deepEqual(result.results.map(item => item.state), ['done']);
  assert.equal(report.profileCreated, true);
  assert.equal(report.browser, 'passed');
  assert.equal(report.nodeSubprocess, 'passed');
  assert.equal(existsSync(report.scratch), false);
});

test('Windows controller death preserves the active claim and fences a surviving worker', {
  skip: !live || process.platform !== 'win32', timeout: 45000
}, async t => {
  const { scratch, repo, stateDir } = disposable(t);
  const controllerScript = join(scratch, 'controller.mjs');
  const readyFile = join(scratch, 'worker-ready');
  const releaseFile = join(scratch, 'worker-release');
  const queue = { target: repo, allowedRepos: [repo], issues: [1, 2].map(number => ({
    number, state: 'ready', model: 'terra', dependencies: [], prompt: 'Local crash fixture'
  })) };
  const moduleUrl = new URL('../src/controller.js', import.meta.url).href;
  writeFileSync(controllerScript, [
    "import { spawn } from 'node:child_process';",
    "import { execute } from " + JSON.stringify(moduleUrl) + ";",
    "const worker = " + JSON.stringify([
      "const { existsSync, writeFileSync } = require('node:fs');",
      "writeFileSync('unfinished.txt', 'preserve me');",
      "writeFileSync(process.argv[1], String(process.pid));",
      "const timer = setInterval(() => {",
      "  if (existsSync(process.argv[2])) { clearInterval(timer); process.exit(0); }",
      "}, 30);",
      "setTimeout(() => process.exit(0), 30000).unref();"
    ].join('\n')) + ";",
    "await execute(" + JSON.stringify(queue) + ", " + JSON.stringify(stateDir) +
      ", { executable: process.execPath, limit: 2 }, ({ cwd, onRecord }) => new Promise(resolve => {",
    "  const child = spawn(process.execPath, ['-e', worker, ...process.argv.slice(2)], { cwd, stdio: 'ignore', detached: true, windowsHide: true });",
    "  child.on('error', () => resolve({ state: 'failed' }));",
    "  child.on('exit', () => resolve({ state: 'done' }));",
    "  onRecord({ type: 'worker-started', pid: child.pid });",
    "}));"
  ].join('\n'));
  const supervisor = spawn(process.execPath, [controllerScript, readyFile, releaseFile], {
    cwd: scratch, stdio: 'ignore', windowsHide: true
  });
  const exited = once(supervisor, 'exit');
  t.after(() => {
    writeFileSync(releaseFile, '');
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill();
  });
  for (let attempt = 0; attempt < 100 && !existsSync(readyFile); attempt++) await delay(50);
  assert.ok(existsSync(readyFile), 'the disposable worker never started');

  const workerPid = Number(readFileSync(readyFile, 'utf8'));
  assert.ok(Number.isSafeInteger(workerPid) && workerPid > 0);
  assert.equal(process.kill(workerPid, 0), true);
  const neverLaunch = () => assert.fail('unexpected worker launch while interrupted');
  await assert.rejects(execute(queue, stateDir, { executable: 'unused', limit: 2 }, neverLaunch),
    /Another controller owns this state directory/);
  assert.equal(supervisor.kill(), true);
  await exited;
  assert.equal(process.kill(workerPid, 0), true, 'worker should survive the supervisor crash');

  const held = await execute(queue, stateDir, { executable: 'unused', limit: 2 }, neverLaunch);
  assert.deepEqual(held, { reason: 'interrupted-worker-needs-review', results: [] });
  const store = new State(stateDir, { readOnly: true });
  try {
    assert.equal(store.task(1).pid, workerPid);
    assert.equal(store.task(1).state, 'interrupted');
    assert.equal(store.task(2), undefined);
    assert.equal(readFileSync(join(store.task(1).worktree, 'unfinished.txt'), 'utf8'), 'preserve me');
  } finally { store.close(); }

  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const acknowledge = () => spawnSync(process.execPath, [
    cli, 'acknowledge', '1', '--state', stateDir, '--confirm-process-exited'
  ], { cwd: scratch, windowsHide: true, encoding: 'utf8', timeout: 5000 });
  const rejected = acknowledge();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Recorded worker PID \d+ is still present/);

  writeFileSync(releaseFile, '');
  let absent = false;
  for (let attempt = 0; attempt < 100 && !absent; attempt++) {
    try { process.kill(workerPid, 0); }
    catch (error) {
      if (error.code !== 'ESRCH') throw error;
      absent = true;
    }
    if (!absent) await delay(50);
  }
  assert.ok(absent, 'worker did not exit after releasing the fixture');
  const acknowledged = acknowledge();
  assert.equal(acknowledged.status, 0, acknowledged.stderr);
  const next = await execute(queue, stateDir, { executable: 'unused', limit: 2 },
    async () => ({ state: 'done' }));
  assert.deepEqual(next.results.map(result => [result.number, result.state]), [[2, 'done']]);
  assert.deepEqual(await execute(queue, stateDir, { executable: 'unused', limit: 2 }, neverLaunch),
    { reason: 'no-eligible-work', results: [] });
});

for (const reason of ['cancelled', 'timeout']) {
  test('Windows ' + reason + ' terminates the real subprocess tree', {
    skip: !live || process.platform !== 'win32', timeout: 15000
  }, async t => {
    const scratch = mkdtempSync(join(tmpdir(), 'orchestrator-process-'));
    t.diagnostic('Retained process fixture: ' + scratch);
    const marker = join(scratch, 'child-pid.txt');
    const script = join(scratch, 'hold.cjs');
    writeFileSync(script, [
      "const { spawn } = require('node:child_process');",
      "const code = 'setInterval(() => {}, 1000)';",
      "const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });",
      "require('node:fs').writeFileSync(process.argv[2], String(child.pid));",
      "setInterval(() => {}, 1000);"
    ].join('\n'));
    const abort = new AbortController();
    const run = runCodex({
      executable: process.execPath, cwd: scratch, model: 'terra', prompt: 'fixture',
      timeoutMs: 5000, signal: abort.signal
    }, (executable, _args, options) => spawn(executable, [script, marker], options));
    for (let attempt = 0; attempt < 40 && !existsSync(marker); attempt++) await delay(50);
    assert.ok(existsSync(marker), 'grandchild did not start');
    if (reason === 'cancelled') abort.abort();
    assert.equal((await run).detail, reason);
    const pid = Number(readFileSync(marker, 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
}
