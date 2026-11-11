import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execute, preview } from '../src/controller.js';
import { stateDirectory, State } from '../src/state.js';
import { createWorktree, git, removeCleanWorktree, worktreeLocation } from '../src/worktrees.js';

const options = { executable: 'mock', limit: 10 };
const task = (number, dependencies = [], model = 'terra') => ({
  number, state: 'ready', model, dependencies, prompt: 'Task ' + number
});
const done = async () => ({ state: 'done' });
const remoteReady = (number, dependencies = []) => ({ number, state: 'ready', model: 'terra', dependencies });

function fixture(t, issues = [task(1)]) {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  writeFileSync(join(repo, '.gitignore'), '*.cache\n');
  git(repo, ['add', '.gitignore']);
  git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c',
    'commit.gpgsign=false', 'commit', '-m', 'seed']);
  return { repo, stateDir: stateDirectory(join(root, 'state')), queue: { target: repo, allowedRepos: [repo], issues } };
}

function withState(path, callback) {
  const store = new State(path);
  try { return callback(store); } finally { store.close(); }
}

test('worktrees are isolated, reject duplicates, and only clean after all changes are preserved', t => {
  const { repo, stateDir } = fixture(t);
  const base = git(repo, ['rev-parse', 'HEAD']);
  const location = worktreeLocation(stateDir, 1);
  createWorktree(repo, location, base);
  assert.throws(() => createWorktree(repo, location, base), /already exists/);
  const ignored = join(location.path, 'uncommitted.cache');
  writeFileSync(ignored, 'preserve this');
  assert.equal(existsSync(join(repo, 'uncommitted.cache')), false);
  assert.throws(() => removeCleanWorktree(repo, location), /clean worktree/);
  rmSync(ignored);
  removeCleanWorktree(repo, location);
  assert.equal(existsSync(location.path), false);
  assert.equal(git(repo, ['rev-parse', location.branch]), base);
  assert.throws(() => createWorktree(repo, location, base), /already exists/);
});

test('continues after a blocked task, then releases dependent work after success', async t => {
  const { queue, stateDir } = fixture(t, [task(1), task(2, [1]), task(3, [], 'sol'), task(4, [3])]);
  const order = [];
  const result = await execute(queue, stateDir, options, async ({ cwd, model }) => {
    order.push(model);
    writeFileSync(join(cwd, 'partial.txt'), 'preserved');
    return { state: order.length === 1 ? 'blocked' : 'done' };
  });
  assert.deepEqual(result.results.map(row => [row.number, row.state]), [[1, 'blocked'], [3, 'done'], [4, 'done']]);
  assert.deepEqual(order, ['terra', 'sol', 'terra']);
  const rerun = await execute(queue, stateDir, options, () => assert.fail('duplicate work'));
  assert.deepEqual(rerun, { reason: 'no-eligible-work', results: [] });
  assert.ok(existsSync(join(stateDir, 'worktrees', 'task-1', 'partial.txt')));
});

test('holds independent tasks when a worker cannot confirm tree termination', async t => {
  const { queue, stateDir } = fixture(t, [task(1), task(2)]);
  let launched = 0;
  const result = await execute(queue, stateDir, options, async () => {
    launched++;
    return { state: 'interrupted', detail: 'process-tree-exit-unconfirmed' };
  });
  assert.equal(result.reason, 'interrupted-worker-needs-review');
  assert.equal(launched, 1);
  assert.equal(withState(stateDir, store => store.task(1).state), 'interrupted');
  assert.deepEqual((await preview(queue, stateDir)).eligible, []);
});

test('a second controller cannot claim tasks while a run owns the state', async t => {
  const { queue, stateDir } = fixture(t);
  await execute(queue, stateDir, options, async () => {
    await assert.rejects(execute(queue, stateDir, options, () => assert.fail()), /Another controller/);
    return { state: 'done' };
  });
});

test('rejects targets outside the allowlist', async t => {
  const { queue, stateDir } = fixture(t);
  queue.allowedRepos = [];
  await assert.rejects(execute(queue, stateDir, options, () => assert.fail()), /outside allowedRepos/);
});

test('restarts hold interrupted claims for inspection and never relaunch them', async t => {
  const { queue, stateDir, repo } = fixture(t, [task(1), task(2)]);
  const location = worktreeLocation(stateDir, 1);
  createWorktree(repo, location, git(repo, ['rev-parse', 'HEAD']));
  writeFileSync(join(location.path, 'unfinished.txt'), 'preserved');
  withState(stateDir, store => {
    store.bind(repo);
    store.reserve({ number: 1, repo, worker: 'local-1', model: 'gpt-6.1-terra', location, log: 'log' });
    store.process(1, { pid: 1234 });
  });
  const hold = await execute(queue, stateDir, options, () => assert.fail('orphan not reviewed'));
  assert.equal(hold.reason, 'interrupted-worker-needs-review');
  withState(stateDir, store => {
    assert.equal(store.task(1).state, 'interrupted');
    assert.equal(store.task(1).pid, 1234);
    store.acknowledge(1);
  });
  const resumed = await execute(queue, stateDir, options, done);
  assert.deepEqual(resumed.results.map(item => item.number), [2]);
  assert.ok(existsSync(join(location.path, 'unfinished.txt')));
});

test('pause drains the current task and prevents another launch until unpaused', async t => {
  const { queue, stateDir } = fixture(t, [task(1), task(2)]);
  const result = await execute(queue, stateDir, options, async ({ signal }) => {
    withState(stateDir, store => store.set('control', 'pause'));
    assert.equal(signal.aborted, false);
    return { state: 'done' };
  });
  assert.equal(result.reason, 'pause');
  assert.equal(result.results.length, 1);
  const paused = await execute(queue, stateDir, options, () => assert.fail('paused'));
  assert.equal(paused.reason, 'pause');
  withState(stateDir, store => store.set('control', 'running'));
  assert.equal((await execute(queue, stateDir, options, done)).results[0].number, 2);
});

test('stop cancels the current worker and persists across restarts', async t => {
  const { queue, stateDir } = fixture(t, [task(1), task(2)]);
  const result = await execute(queue, stateDir, options, async ({ signal }) => {
    withState(stateDir, store => store.set('control', 'stop'));
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { state: 'stopped' };
  });
  assert.equal(result.reason, 'stopped');
  assert.equal(result.results.length, 1);
  assert.equal(withState(stateDir, store => store.task(1).state), 'stopped');
  assert.equal((await execute(queue, stateDir, options, () => assert.fail())).reason, 'stop');
});

test('previews local tasks in real dispatch order using saved outcomes and controls', async t => {
  const { queue, stateDir } = fixture(t, [task(1), { ...task(2), priority: 0 }, task(3, [2])]);
  const missing = join(stateDir, 'unused');
  assert.deepEqual((await preview(queue, missing)).eligible.map(row => row.number), [2, 1]);
  assert.equal(existsSync(missing), false);
  const first = await execute(queue, stateDir, { ...options, limit: 1 }, done);
  assert.equal(first.results[0].number, 2);
  assert.deepEqual((await preview(queue, stateDir)).eligible.map(row => row.number), [1, 3]);
  withState(stateDir, store => store.set('control', 'pause'));
  assert.deepEqual(await preview(queue, stateDir), { mode: 'dry-run', reason: 'pause', eligible: [] });
});

test('rejects state paths under a checkout or its shared Git directory before creating them', async t => {
  const { queue, repo, stateDir } = fixture(t);
  const linked = join(stateDir, 'linked-checkout');
  git(repo, ['worktree', 'add', '--detach', '--', linked, 'HEAD']);
  for (const [target, path] of [[repo, join(repo, 'new-state')], [linked, join(repo, '.git', 'new-state')]]) {
    await assert.rejects(execute({ ...queue, target, allowedRepos: [target] }, path, options,
      () => assert.fail('unsafe state directory')), /must be separate/);
    assert.equal(existsSync(path), false);
  }
});

test('a log collision preserves the existing log and stops before launching any worker', async t => {
  const { queue, stateDir } = fixture(t, [task(1), task(2)]);
  const dir = join(stateDir, 'logs');
  mkdirSync(dir);
  const log = join(dir, 'task-1.jsonl');
  writeFileSync(log, 'previous output');
  const result = await execute(queue, stateDir, options, () => assert.fail('log collision'));
  assert.deepEqual(result, { reason: 'recording-failed', results: [
    { number: 1, state: 'failed', detail: 'recording-failed' }
  ] });
  assert.equal(withState(stateDir, store => store.task(1).state), 'failed');
  assert.equal(readFileSync(log, 'utf8'), 'previous output');
});

test('refreshes GitHub readiness and remembers a claim while the issue stays ready', async t => {
  const { queue, stateDir, repo } = fixture(t, [task(1), task(2), task(3)]);
  queue.sourceRepo = 'Fixture/Issue-Queue';
  git(repo, ['remote', 'add', 'origin', 'git@github.com:fixture/issue-queue.git']);
  const first = remoteReady(1);
  const second = remoteReady(2, [1]);
  const unavailable = remoteReady(3, [99]);
  const unapproved = remoteReady(4);
  let reads = 0;
  const result = await execute(queue, stateDir, { ...options, readIssues: async source => {
    assert.equal(source, 'fixture/issue-queue');
    reads++;
    const latest = reads === 1 ? second : { ...second, state: 'blocked' };
    return [first, latest, unavailable, unapproved];
  } }, async ({ prompt, cwd }) => {
    const row = withState(stateDir, store => store.task(1));
    assert.equal(row.state, 'running');
    assert.equal(row.worktree, cwd);
    assert.equal(row.branch, 'orchestrator/github-issue-1');
    assert.match(prompt, /Operator-reviewed task:\nTask 1$/);
    return done();
  });
  assert.equal(reads, 2);
  assert.deepEqual(result.results.map(row => row.number), [1]);
  const readIssues = async () => [first, second, unavailable, unapproved];
  assert.deepEqual((await preview(queue, stateDir, { readIssues })).eligible.map(row => row.number), [2]);
  const restart = await execute(queue, stateDir, { ...options, readIssues }, done);
  assert.deepEqual(restart.results.map(row => row.number), [2]);
  assert.deepEqual(withState(stateDir, store => store.list().map(row => row.number)), [1, 2]);
});

test('does not reserve work if pause arrives during a GitHub request', async t => {
  const { queue, stateDir, repo } = fixture(t);
  queue.sourceRepo = 'fixture/issue-queue';
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/issue-queue.git']);
  const result = await execute(queue, stateDir, { ...options, readIssues: async () => {
    withState(stateDir, store => store.set('control', 'pause'));
    return [remoteReady(1)];
  } }, () => assert.fail('paused'));
  assert.deepEqual(result, { reason: 'pause', results: [] });
  assert.deepEqual(withState(stateDir, store => store.list()), []);
});

test('rejects a mismatched origin or a different claim source before polling', async t => {
  const { queue, stateDir, repo } = fixture(t);
  queue.sourceRepo = 'fixture/issue-queue';
  const guarded = { ...options, readIssues: () => assert.fail('wrong source polled') };
  await assert.rejects(execute(queue, stateDir, guarded), /checkout origin must match/);
  assert.equal(existsSync(join(stateDir, 'tasks.sqlite')), false);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/issue-queue.git']);
  await execute(queue, stateDir, { ...options, readIssues: async () => [] });
  const other = { ...queue, sourceRepo: 'fixture/other-queue' };
  git(repo, ['remote', 'set-url', 'origin', 'https://github.com/fixture/other-queue.git']);
  await assert.rejects(execute(other, stateDir, guarded), /different task source/);
  await assert.rejects(preview(other, stateDir, guarded), /different task source/);
  await assert.rejects(execute({ ...queue, sourceRepo: undefined }, stateDir, guarded), /different task source/);
});

test('preserves earlier claims when a later GitHub poll fails', async t => {
  const { queue, stateDir, repo } = fixture(t, [task(1), task(2)]);
  queue.sourceRepo = 'fixture/issue-queue';
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/issue-queue.git']);
  let reads = 0;
  const readIssues = async () => {
    if (++reads > 1) throw new Error('poll failed');
    return [remoteReady(1), remoteReady(2)];
  };
  await assert.rejects(execute(queue, stateDir, { ...options, readIssues }, done), /poll failed/);
  assert.deepEqual(withState(stateDir, store => store.list().map(row => [row.number, row.state])), [[1, 'done']]);
});
