import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execute } from '../src/controller.js';
import { stateDirectory, State } from '../src/state.js';
import { createWorktree, git, removeCleanWorktree, worktreeLocation } from '../src/worktrees.js';

const options = { executable: 'mock', limit: 10 };
const task = (number, dependencies = [], model = 'terra') => ({
  number, state: 'ready', model, dependencies, prompt: 'Task ' + number
});
const done = async () => ({ state: 'done' });

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
