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

test('local queues publish progress to their matching origin and reconcile the same comment on restart', async t => {
  const { repo, queue, stateDir } = fixture(t);
  const statusRepo = 'fixture/local-status';
  git(repo, ['remote', 'add', 'origin', 'https://github.com/' + statusRepo + '.git']);
  queue.statusRepo = 'fixture/other';
  const labels = new Set(['keep']);
  let comment, posts = 0;
  const api = {
    async issue(name, number) {
      assert.equal(name, statusRepo);
      assert.equal(number, 1);
      return { number, html_url: 'https://github.com/' + name + '/issues/' + number, state: 'open',
        labels: [...labels].map(name => ({ name })) };
    },
    async add(_name, _number, label) { labels.add(label); },
    async remove(_name, _number, label) { labels.delete(label); },
    async viewer() { return 1; },
    async comments() { return comment ? [comment] : []; },
    async post(_name, _number, body) {
      posts++;
      comment = { id: 2, user: { id: 1 }, body };
      return comment;
    },
    async edit(_name, _id, body) { comment.body = body; }
  };
  const config = { ...options, publishStatus: true, statusApi: api };
  const never = () => assert.fail('unexpected worker');
  await assert.rejects(execute(queue, stateDir, config, never), /matching GitHub origin/);
  queue.statusRepo = statusRepo;
  await execute(queue, stateDir, config, async ({ onRecord }) => {
    onRecord({ type: 'worker-started', pid: 1234 });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(comment.body, /In progress/);
    return { state: 'blocked' };
  });
  assert.match(comment.body, /Blocked/);
  assert.deepEqual([...labels], ['keep', 'blocked']);
  assert.deepEqual((await execute(queue, stateDir, config, never)).results, []);
  assert.equal(posts, 1);
  withState(stateDir, state => {
    assert.equal(state.get('sourceRepo'), undefined);
    assert.equal(state.get('statusRepo'), statusRepo);
    assert.deepEqual(JSON.parse(state.get('statusNumbers')), [1]);
    assert.equal(state.task(1).branch, 'orchestrator/task-1');
    assert.equal(state.githubProgress(1)[0].comment, 2);
  });
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
  withState(stateDir, store => {
    store.bind(repo);
    const attempt = store.reserve({ number: 1, repo, worker: 'local-1', model: 'gpt-6.1-terra',
      location, log: 'log', base: git(repo, ['rev-parse', 'HEAD']) });
    store.process(1, attempt, { pid: 1234 });
  });
  createWorktree(repo, location, git(repo, ['rev-parse', 'HEAD']));
  writeFileSync(join(location.path, 'unfinished.txt'), 'preserved');
  const hold = await execute(queue, stateDir, options, () => assert.fail('orphan not reviewed'));
  assert.equal(hold.reason, 'interrupted-worker-needs-review');
  withState(stateDir, store => {
    assert.equal(store.task(1).state, 'interrupted');
    assert.equal(store.task(1).pid, 1234);
    assert.equal(store.attempts()[0].state, 'interrupted');
    assert.equal(store.attempts()[0].pid, 1234);
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
  withState(stateDir, store => store.bind(queue.target));
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

test('GitHub completion releases dependencies with unsuccessful local claims', async t => {
  const { queue, stateDir, repo } = fixture(t, [task(1), task(2), task(3), task(4)]);
  queue.sourceRepo = 'fixture/issue-queue';
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/issue-queue.git']);
  const outcomes = ['failed', 'blocked', 'stopped'];
  withState(stateDir, store => {
    store.bind(repo, queue.sourceRepo);
    for (const [index, state] of outcomes.entries()) {
      const number = index + 1;
      const attempt = store.reserve({ number, repo, worker: 'local-1', model: 'gpt-6.1-terra',
        location: worktreeLocation(stateDir, number, queue.sourceRepo), log: 'log', base: git(repo, ['rev-parse', 'HEAD']) });
      store.finish(number, attempt, { state });
    }
  });
  const dependent = remoteReady(4, [1, 2, 3]);
  let snapshot = [remoteReady(1), remoteReady(2), remoteReady(3), dependent];
  const readIssues = async () => snapshot;
  assert.deepEqual((await preview(queue, stateDir, { readIssues })).eligible, []);

  snapshot = [...snapshot.slice(0, 3).map(issue => ({ ...issue, state: 'done' })), dependent];
  assert.deepEqual((await preview(queue, stateDir, { readIssues })).eligible.map(issue => issue.number), [4]);
  const result = await execute(queue, stateDir, { ...options, readIssues }, done);
  assert.deepEqual(result.results.map(issue => [issue.number, issue.state]), [[4, 'done']]);
  assert.deepEqual(withState(stateDir, store => store.list().map(row => row.state)), [...outcomes, 'done']);
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

test('keeps GitHub-backed runs read-only without decision opt-in', async t => {
  const { queue, stateDir, repo } = fixture(t);
  queue.sourceRepo = 'fixture/decision-queue';
  queue.authorizedResponders = [51];
  queue.issues[0].decisions = [{ key: 'layout', question: 'Which layout?', choices: [
    { id: 'list', label: 'List', instruction: 'Use a list.' },
    { id: 'grid', label: 'Grid', instruction: 'Use a grid.' }
  ] }];
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/decision-queue.git']);
  const result = await execute(queue, stateDir, { ...options, readIssues: async () => [remoteReady(1)],
    decisionApi: { async viewer() { assert.fail('decision API called without opt-in'); } }
  }, async () => ({ state: 'blocked', result: { decisionKey: 'layout' } }));
  assert.deepEqual(result.results.map(row => row.state), ['blocked']);
  assert.deepEqual(withState(stateDir, store => store.decisionStatus()), []);
});

test('recovers an ambiguous decision delivery and resumes a saved answer once in the same worktree', async t => {
  const { queue, stateDir, repo } = fixture(t, [task(1), task(2)]);
  queue.sourceRepo = 'fixture/decision-queue';
  queue.authorizedResponders = [51];
  queue.issues[0].decisions = [{
    key: 'layout', question: 'Which layout should we use?',
    choices: [
      { id: 'list', label: 'List layout', instruction: 'Use the approved list layout.' },
      { id: 'grid', label: 'Grid layout', instruction: 'Use the approved grid layout.' }
    ]
  }];
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/decision-queue.git']);

  const time = '2026-11-11T10:00:00Z';
  let posts = 0;
  let posted;
  let visible = false;
  let replies = [];
  let commentsUnavailable = false;
  let dependencies = [];
  const decisionApi = {
    async viewer() { return 10; },
    async comments() {
      if (commentsUnavailable) throw new Error('fixture GitHub outage');
      return visible ? [posted, ...replies] : [];
    },
    async post(repoName, number, body) {
      assert.equal(repoName, queue.sourceRepo);
      assert.equal(number, 1);
      assert.match(body, /Which layout should we use\?/);
      assert.doesNotMatch(body, /private worker output|Use the approved/);
      posts++;
      posted = { id: 21, user: { id: 10 }, body, created_at: time };
      throw new Error('Lost the response after GitHub created the comment');
    }
  };
  const configured = { ...options, decisionsEnabled: true, decisionApi,
    readIssues: async () => [remoteReady(1, dependencies), remoteReady(2)] };
  let originalWorktree;
  const initial = await execute(queue, stateDir, configured, async ({ cwd, prompt }) => {
    if (prompt.endsWith('Task 2')) return done();
    originalWorktree = cwd;
    writeFileSync(join(cwd, 'unfinished.txt'), 'prior work');
    return { state: 'blocked', result: { decisionKey: 'layout', summary: 'private worker output' } };
  });
  assert.deepEqual(initial.results.map(row => [row.number, row.state]), [[1, 'blocked'], [2, 'done']]);
  const id = initial.results[0].decision;
  const status = () => withState(stateDir, store => store.decisionStatus()[0]);
  assert.equal(status().posting, 1);
  assert.equal(status().last_error, 'delivery-unconfirmed');

  visible = true;
  const command = '/orchestrator decide ' + id + ' grid';
  const comment = (id, author) => ({ id, user: { id: author, type: 'User' }, body: command,
    created_at: time, updated_at: time });
  replies = [comment(22, 99)];
  const rejected = await execute(queue, stateDir, configured, () => assert.fail('unauthorized resume'));
  assert.equal(rejected.results.length, 0);
  assert.equal(status().request_comment, 21);
  assert.equal(status().reply_comment, null);

  // Capture the reply before the task becomes eligible, then restart with the saved answer.
  dependencies = [99];
  replies.push(comment(23, 51));
  const held = await execute(queue, stateDir, configured, () => assert.fail('dependency unavailable'));
  assert.equal(held.results.length, 0);
  assert.equal(status().reply_comment, 23);
  assert.equal(status().consumed, null);

  dependencies = [];
  async function assertHeld(reason) {
    const result = await execute(queue, stateDir, configured, () => assert.fail('invalid saved reply resumed'));
    assert.deepEqual(result.results, []);
    assert.equal(status().reply_comment, 23);
    assert.equal(status().consumed, null);
    assert.equal(status().last_error, reason);
  }

  commentsUnavailable = true;
  await assertHeld('comments-unavailable');
  commentsUnavailable = false;
  queue.authorizedResponders = [52];
  await assertHeld('saved-reply-no-longer-authorized');
  queue.authorizedResponders = [51];
  replies = [{ ...comment(23, 51), updated_at: '2026-11-11T10:01:00Z' }];
  await assertHeld('saved-reply-no-longer-authorized');
  replies = [];
  await assertHeld('saved-reply-no-longer-authorized');
  replies = [comment(24, 51)];
  queue.issues[0].decisions[0].choices[1].instruction = 'Changed local text after publication.';
  const resumed = await execute(queue, stateDir, configured, async ({ cwd, prompt }) => {
    assert.equal(cwd, originalWorktree);
    assert.equal(readFileSync(join(cwd, 'unfinished.txt'), 'utf8'), 'prior work');
    assert.match(prompt, /Authorized choice: grid/);
    assert.match(prompt, /Use the approved grid layout/);
    assert.doesNotMatch(prompt, /Changed local text/);
    return done();
  });
  assert.deepEqual(resumed.results.map(row => [row.number, row.state, row.resumedFrom]), [[1, 'done', id]]);
  assert.ok(status().consumed);
  assert.equal(status().reply_comment, 24);
  assert.equal(withState(stateDir, store => store.task(1).retries), 1);
  assert.equal(posts, 1);
  const restart = await execute(queue, stateDir, configured, () => assert.fail('duplicate resume'));
  assert.deepEqual(restart.results, []);
});

test('resuming a second decision preserves every approved instruction for that task', async t => {
  const { queue, stateDir, repo } = fixture(t);
  queue.sourceRepo = 'fixture/decision-queue';
  queue.authorizedResponders = [51];
  queue.issues[0].decisions = ['layout', 'color'].map(key => ({
    key,
    question: 'Choose the ' + key,
    choices: [
      { id: 'first', label: 'First', instruction: 'Apply the approved ' + key + '.' },
      { id: 'second', label: 'Second', instruction: 'Do not apply the first ' + key + '.' }
    ]
  }));
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/decision-queue.git']);

  const time = '2026-11-11T10:00:00Z';
  const comments = [];
  const configured = { ...options, limit: 1, decisionsEnabled: true,
    readIssues: async () => [remoteReady(1)],
    decisionApi: {
      async viewer() { return 10; },
      async comments() { return comments; },
      async post(_repo, _number, body) {
        const comment = { id: comments.length + 1, user: { id: 10 }, body, created_at: time };
        comments.push(comment);
        return comment;
      }
    }
  };
  const reply = decision => comments.push({
    id: comments.length + 1, user: { id: 51, type: 'User' },
    body: '/orchestrator decide ' + decision + ' first', created_at: time, updated_at: time
  });

  const initial = await execute(queue, stateDir, configured, async ({ onRecord }) => {
    onRecord({ pid: 1234, threadId: 'first-session' });
    return { state: 'blocked', result: { decisionKey: 'layout' } };
  });
  reply(initial.results[0].decision);
  const second = await execute(queue, stateDir, configured,
    async () => ({ state: 'blocked', result: { decisionKey: 'color' } }));
  reply(second.results[0].decision);

  let finalPrompt;
  const finished = await execute(queue, stateDir, configured, async ({ prompt, onRecord }) => {
    const [first, , active] = withState(stateDir, store => store.attempts());
    assert.equal(first.session, 'first-session');
    assert.equal(active.state, 'running');
    assert.notEqual(active.id, first.id);
    withState(stateDir, store => {
      assert.throws(() => store.process(1, first.id, { pid: 5678 }), /no longer owns/);
      assert.throws(() => store.finish(1, first.id, { state: 'done' }), /no longer owns/);
      assert.equal(store.task(1).state, 'running');
    });
    onRecord({ pid: 9012, threadId: 'third-session' });
    finalPrompt = prompt;
    return done();
  });
  assert.deepEqual(finished.results.map(row => row.state), ['done']);
  assert.match(finalPrompt, /Apply the approved layout\.[\s\S]*Apply the approved color\./);
  assert.doesNotMatch(finalPrompt, /Do not apply the first/);
  const history = withState(stateDir, store => store.attempts());
  assert.deepEqual(history.map(item => item.state), ['blocked', 'blocked', 'done']);
  assert.deepEqual(history.map(item => item.decision), [null, initial.results[0].decision, second.results[0].decision]);
  assert.deepEqual(history.map(item => item.session), ['first-session', null, 'third-session']);
  assert.ok(history.every(item => item.completed && item.base === git(repo, ['rev-parse', 'HEAD'])));
  assert.equal(new Set(history.map(item => item.log)).size, 3);
  assert.ok(history.every(item => readFileSync(item.log, 'utf8').split('\n').filter(Boolean)
    .every(line => JSON.parse(line).attempt === item.id)));
});


test('strict scheduling waits for a reviewed prerequisite in the actual worktree base', async t => {
  const { queue, stateDir, repo } = fixture(t, [task(1), task(2, [1])]);
  queue.sourceRepo = 'fixture/issue-queue';
  queue.acceptedPrerequisites = [];
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/issue-queue.git']);
  const readIssues = async () => [{ ...remoteReady(1), state: 'done' }, remoteReady(2)];
  const configured = { ...options, readIssues };

  // An issue closed as completed is insufficient.
  assert.deepEqual((await preview(queue, stateDir, { readIssues })).eligible, []);
  // A worker's local completion is insufficient too.
  const first = await execute(queue, stateDir, { ...options, readIssues: async () => [remoteReady(1)] }, done);
  assert.deepEqual(first.results.map(row => row.number), [1]);
  assert.deepEqual((await preview(queue, stateDir, { readIssues })).eligible, []);
  assert.deepEqual((await execute(queue, stateDir, configured, () => assert.fail('unaccepted prerequisite'))).results, []);

  const candidate = worktreeLocation(stateDir, 1, queue.sourceRepo).path;
  writeFileSync(join(candidate, 'accepted.txt'), 'reviewed content');
  git(candidate, ['add', 'accepted.txt']);
  git(candidate, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c',
    'commit.gpgsign=false', 'commit', '-m', 'Candidate']);
  queue.acceptedPrerequisites = [{ number: 1, commit: git(candidate, ['rev-parse', 'HEAD']) }];
  await assert.rejects(preview(queue, stateDir, { readIssues }), /not a commit in the dispatch base history/);
  await assert.rejects(execute(queue, stateDir, configured, done), /not a commit in the dispatch base history/);
  git(repo, ['merge', '--ff-only', queue.acceptedPrerequisites[0].commit]);

  assert.deepEqual((await preview(queue, stateDir, { readIssues })).eligible.map(row => row.number), [2]);
  const result = await execute(queue, stateDir, configured, async ({ cwd }) => {
    assert.equal(readFileSync(join(cwd, 'accepted.txt'), 'utf8'), 'reviewed content');
    return done();
  });
  assert.deepEqual(result.results.map(row => row.number), [2]);
  delete queue.acceptedPrerequisites;
  await assert.rejects(preview(queue, stateDir, { readIssues }), /different prerequisite policy/);
});

test('continuous watch dispatches after several idle polls and stops at its execution limit', async t => {
  const { queue, repo, stateDir } = fixture(t, [task(1, [3])]);
  queue.issues.push({ ...task(3), state: 'done' });
  queue.acceptedPrerequisites = [];
  let polls = 0, merged;
  const result = await execute(queue, stateDir, {
    ...options, limit: 1, polls: 1, continuous: true, intervalMs: 5,
    readAcceptance() {
      if (++polls < 4) return [];
      writeFileSync(join(repo, 'accepted.txt'), 'new main');
      git(repo, ['add', 'accepted.txt']);
      git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '-m', 'Integrate prerequisite']);
      merged = git(repo, ['rev-parse', 'HEAD']);
      return [{ number: 3, commit: merged }];
    }
  }, async ({ cwd }) => {
    assert.equal(git(cwd, ['rev-parse', 'HEAD']), merged);
    assert.equal(readFileSync(join(cwd, 'accepted.txt'), 'utf8'), 'new main');
    return done();
  });
  assert.equal(polls, 4);
  assert.equal(result.reason, 'execution-limit');
  assert.deepEqual(result.results.map(row => row.number), [1]);
});

test('continuous polling fills an idle slot when work arrives during a running worker', async t => {
  const { queue, repo, stateDir } = fixture(t, [task(1), task(2)]);
  queue.workerSlots = 2;
  queue.sourceRepo = 'Fixture/Issue-Queue';
  git(repo, ['remote', 'add', 'origin', 'git@github.com:fixture/issue-queue.git']);
  let reads = 0, running = false, overlapped = false, finish;
  const barrier = new Promise(resolve => { finish = resolve; });
  const timeout = setTimeout(finish, 5000);
  t.after(() => clearTimeout(timeout));
  await execute(queue, stateDir, { ...options, continuous: true, limit: 2, intervalMs: 5, signal: AbortSignal.timeout(15000),
    readIssues: async () => ++reads < 3 ? [remoteReady(1)] : [remoteReady(1), remoteReady(2)]
  }, async ({ prompt }) => {
    if (prompt.endsWith('Task 1')) {
      running = true;
      await barrier;
      running = false;
    } else {
      overlapped = running;
      finish();
    }
    return done();
  });
  assert.equal(overlapped, true);
});

test('continuous watch honors a pause during an idle poll', async t => {
  const { queue, stateDir } = fixture(t, [{ ...task(1), state: 'blocked' }]);
  queue.acceptedPrerequisites = [];
  const result = await execute(queue, stateDir, {
    ...options, polls: 1, continuous: true, intervalMs: 5,
    readAcceptance() {
      withState(stateDir, state => state.set('control', 'pause'));
      return [];
    }
  }, () => assert.fail('unexpected worker'));
  assert.deepEqual(result, { reason: 'pause', results: [] });
});

test('watched acceptance holds if a recorded receipt disappears between dispatches', async t => {
  const { queue, repo, stateDir } = fixture(t, [task(1), task(2)]);
  const base = git(repo, ['rev-parse', 'HEAD']);
  queue.acceptedPrerequisites = [{ number: 3, commit: base }];
  let receipts = [...queue.acceptedPrerequisites];
  await assert.rejects(execute(queue, stateDir, { ...options, readAcceptance: () => receipts }, async () => {
    receipts = [];
    return done();
  }), /Acceptance receipt changed or disappeared for #3/);
  assert.equal(withState(stateDir, store => store.task(1).state), 'done');
  assert.equal(withState(stateDir, store => store.task(2)), undefined);
});

test('local watched receipts cannot be dropped by restarting or disabling the watcher', async t => {
  const { queue, repo, stateDir } = fixture(t, [task(1), task(2)]);
  const receipt = { number: 3, commit: git(repo, ['rev-parse', 'HEAD']) };
  queue.acceptedPrerequisites = [];
  const run = await execute(queue, stateDir, { ...options, limit: 1, readAcceptance: () => [receipt] }, done);
  assert.deepEqual(run.results.map(row => row.number), [1]);
  const noWorker = () => assert.fail('dispatch after losing saved receipt');
  await assert.rejects(execute(queue, stateDir, { ...options, readAcceptance: () => [] }, noWorker),
    /Acceptance receipt changed or disappeared for #3/);
  await assert.rejects(execute(queue, stateDir, options, noWorker), /Acceptance receipt changed or disappeared for #3/);
  await assert.rejects(preview(queue, stateDir), /Acceptance receipt changed or disappeared for #3/);
  assert.equal(withState(stateDir, store => store.task(2)), undefined);
  queue.acceptedPrerequisites = [receipt];
  const continued = await execute(queue, stateDir, { ...options, readAcceptance: () => [receipt] }, done);
  assert.deepEqual(continued.results.map(row => row.number), [2]);
});

test('local watched main cannot rewind across a restart even with unchanged receipts', async t => {
  const { queue, repo, stateDir } = fixture(t, [task(1), task(2)]);
  const receipt = { number: 3, commit: git(repo, ['rev-parse', 'HEAD']) };
  queue.acceptedPrerequisites = [receipt];
  git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-m', 'Advance disposable main']);
  const watch = { ...options, limit: 1, readAcceptance: () => [receipt] };
  await execute(queue, stateDir, watch, done);
  git(repo, ['reset', '--keep', receipt.commit]);
  const noWorker = () => assert.fail('dispatch after main rewind');
  await assert.rejects(execute(queue, stateDir, watch, noWorker), /non-fast-forward/);
  await assert.rejects(execute(queue, stateDir, options, noWorker), /non-fast-forward/);
  assert.equal(withState(stateDir, store => store.task(2)), undefined);
});

test('watched acceptance rejects a receipt file in the worker state directory', async t => {
  const { queue, stateDir } = fixture(t);
  queue.acceptedPrerequisites = [];
  await assert.rejects(execute(queue, stateDir, {
    ...options, acceptancePath: join(stateDir, 'acceptance.json'), readAcceptance: () => []
  }, () => assert.fail('unsafe receipt path')), /outside the target checkout and state directory/);
});

test('retries a transient GitHub read and schedules only from the fresh snapshot', async t => {
  const { queue, stateDir, repo } = fixture(t, [task(1), task(2), task(3)]);
  queue.sourceRepo = 'fixture/issue-queue';
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/issue-queue.git']);
  let reads = 0;
  const waits = [];
  const readIssues = async () => {
    reads++;
    if (reads === 1) return [remoteReady(1), remoteReady(2)];
    if (reads <= 3) throw Object.assign(new Error('temporary poll error'), { transient: true });
    return [remoteReady(3)];
  };
  const result = await execute(queue, stateDir, {
    ...options, readIssues, limit: 2,
    waitForIssueRetry: async delay => {
      waits.push(delay);
      assert.equal(withState(stateDir, store => store.task(2)), undefined);
    }
  }, done);
  assert.deepEqual(waits, [5000, 15000]);
  assert.deepEqual(result.results.map(row => row.number), [1, 3]);
  assert.equal(withState(stateDir, store => store.task(2)), undefined);
});

test('caps transient issue-read retries and honors a pause before retrying', async t => {
  const { queue, stateDir, repo } = fixture(t);
  queue.sourceRepo = 'fixture/issue-queue';
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/issue-queue.git']);
  const waits = [];
  const readIssues = async () => { throw Object.assign(new Error('temporary poll error'), { transient: true }); };
  const noWorker = () => assert.fail('dispatch during failed poll');
  await assert.rejects(execute(queue, stateDir, {
    ...options, readIssues, waitForIssueRetry: async delay => { waits.push(delay); }
  }, noWorker), /temporary poll error/);
  assert.deepEqual(waits, [5000, 15000, 60000]);
  const result = await execute(queue, stateDir, {
    ...options, readIssues,
    waitForIssueRetry: async () => withState(stateDir, store => store.set('control', 'pause'))
  }, noWorker);
  assert.equal(result.reason, 'pause');
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

test('three slots overlap isolated claims and a restart never dispatches completed work twice', async t => {
  const { queue, stateDir } = fixture(t, [task(1), task(2), task(3), task(4, [1, 2, 3])]);
  queue.workerSlots = 3;
  const started = [];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const timer = setTimeout(release, 8000);
  t.after(() => clearTimeout(timer));
  const result = await execute(queue, stateDir, { ...options, limit: 3 }, async ({ cwd }) => {
    started.push(cwd);
    if (started.length === 3) release();
    await barrier;
    assert.equal(started.length, 3);
    return { state: 'done' };
  });
  assert.equal(new Set(started).size, 3);
  assert.equal(result.results.length, 3);
  assert.equal(withState(stateDir, state => new Set(state.list().map(row => row.worker)).size), 3);
  const resumed = await execute(queue, stateDir, options, async ({ prompt }) => {
    assert.match(prompt, /Task 4$/);
    return { state: 'done' };
  });
  assert.deepEqual(resumed.results.map(row => row.number), [4]);
});

test('restart fences all three abandoned claims before dispatching new work', async t => {
  const { repo, queue, stateDir } = fixture(t, [task(1), task(2), task(3), task(4)]);
  queue.workerSlots = 3;
  const base = git(repo, ['rev-parse', 'HEAD']);
  withState(stateDir, state => {
    for (const number of [1, 2, 3]) {
      const location = worktreeLocation(stateDir, number);
      createWorktree(repo, location, base);
      state.reserve({ number, repo, worker: 'local-' + number, model: 'gpt-6.1-terra',
        location, base, log: join(stateDir, 'abandoned-' + number + '.jsonl') });
    }
  });
  const result = await execute(queue, stateDir, options, () => assert.fail('unsafe dispatch'));
  assert.equal(result.reason, 'interrupted-worker-needs-review');
  assert.deepEqual(withState(stateDir, state => state.list().map(row => row.state)),
    ['interrupted', 'interrupted', 'interrupted']);
});

test('dispatch continues when a worker finishes during an intake poll', async t => {
  const { queue, stateDir, repo } = fixture(t, [task(1), task(2), task(3)]);
  queue.sourceRepo = 'Fixture/Issue-Queue';
  queue.workerSlots = 3;
  git(repo, ['remote', 'add', 'origin', 'git@github.com:fixture/issue-queue.git']);
  let reads = 0;
  let finish;
  const first = new Promise(resolve => { finish = resolve; });
  const readIssues = async () => {
    if (++reads === 2) {
      finish();
      await new Promise(resolve => setImmediate(resolve));
    }
    return [remoteReady(1), remoteReady(2), remoteReady(3)];
  };
  const result = await execute(queue, stateDir, { ...options, limit: 3, readIssues }, async ({ prompt }) => {
    if (prompt.endsWith('Task 1')) await first;
    return { state: 'done' };
  });
  assert.equal(result.reason, 'execution-limit');
  assert.deepEqual(result.results.map(row => row.number).sort(), [1, 2, 3]);
});

test('dispatches a dependent when its prerequisite finishes during polling', async t => {
  const { queue, stateDir, repo } = fixture(t, [task(1), task(2, [1])]);
  queue.sourceRepo = 'Fixture/Issue-Queue';
  queue.workerSlots = 3;
  git(repo, ['remote', 'add', 'origin', 'git@github.com:fixture/issue-queue.git']);
  let reads = 0;
  let finish;
  const first = new Promise(resolve => { finish = resolve; });
  const readIssues = async () => {
    if (++reads === 2) {
      finish();
      await new Promise(resolve => setImmediate(resolve));
    }
    return [remoteReady(1), remoteReady(2, [1])];
  };
  const result = await execute(queue, stateDir, { ...options, limit: 3, readIssues }, async ({ prompt }) => {
    if (prompt.endsWith('Task 1')) await first;
    return { state: 'done' };
  });
  assert.equal(result.reason, 'no-eligible-work');
  assert.deepEqual(result.results.map(row => row.number).sort(), [1, 2]);
});

