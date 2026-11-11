import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { findCodex, MODELS, runCodex } from '../src/codex.js';
import { execute } from '../src/controller.js';
import { normalizeIssues } from '../src/github.js';
import { stateDirectory, State } from '../src/state.js';
import { git } from '../src/worktrees.js';

const live = process.env.ORCHESTRATOR_LIVE_TEST === '1';

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

test('polls and durably claims Terra and Sol tasks in separate disposable worktrees', {
  skip: !live, timeout: 330000
}, async t => {
  const { scratch, repo, stateDir } = disposable(t);
  const outside = join(scratch, 'outside.txt');
  writeFileSync(outside, 'outside-sentinel');
  writeFileSync(join(repo, 'probe.cjs'), [
    "const { writeFileSync } = require('node:fs');",
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
    prompt: 'Set ' + model + '.txt to exactly the text integrated-' + model +
      ' (a trailing newline is allowed). Read it back. ' +
      (index ? '' : 'Run the committed disposable sandbox probe using node probe.cjs once. ' +
        'It only attempts a write to a synthetic sentinel for this integration test. ' +
        'Report the outcome without modifying the probe or its result file. ') +
      'Return the required structured outcome.'
  }));
  const sourceRepo = 'fixture/disposable-issues';
  git(repo, ['remote', 'add', 'origin', 'https://github.com/' + sourceRepo + '.git']);
  const metadata = ['terra', 'sol', 'terra'].map((model, index) => ({
    number: index + 1,
    title: 'Fixture issue ' + (index + 1),
    state: 'open',
    body: index === 1 ? 'Depends on: #1' : '',
    labels: [{ name: 'agent:ready' }, { name: 'model:' + model }]
  }));
  const queue = { target: repo, allowedRepos: [repo], sourceRepo, issues };
  const executable = findCodex();
  let reads = 0;
  const readIssues = async repoName => {
    assert.equal(repoName, sourceRepo);
    reads++;
    return normalizeIssues([reads === 1 ? [] : metadata]);
  };
  const result = await execute(queue, stateDir, {
    executable, limit: 3, timeoutMs: 140000, polls: 2, intervalMs: 10, readIssues
  });
  const store = new State(stateDir);
  let rows;
  try {
    assert.equal(store.get('sourceRepo'), sourceRepo);
    rows = store.list();
  } finally { store.close(); }
  t.diagnostic(JSON.stringify(result));
  for (const row of rows) {
    t.diagnostic(JSON.stringify({ model: row.model, state: row.state, detail: row.detail,
      exit: row.exit_code, thread: row.session, log: row.log }));
  }
  assert.deepEqual(result.results.map(item => item.state), ['done', 'done']);
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
  assert.match(readFileSync(join(rows[0].worktree, 'probe-result.txt'), 'utf8'), /^(EPERM|EACCES)$/);
  const restart = await execute(queue, stateDir, { executable, limit: 3, readIssues },
    () => assert.fail('restart dispatched a claimed or unapproved task'));
  assert.deepEqual(restart, { reason: 'no-eligible-work', results: [] });
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
