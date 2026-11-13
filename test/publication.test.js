import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execute } from '../src/controller.js';
import { captureVerifiedTree, publicationPolicy, publishVerified } from '../src/publication.js';
import { State } from '../src/state.js';
import { git } from '../src/worktrees.js';

const repo = 'fixture/publication';
const options = { limit: 4 };
const workerForbidden = () => assert.fail('saved implementation reran');

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orchestrator-handoff-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'target'), stateDir = join(root, 'state');
  mkdirSync(target);
  git(target, ['init', '-b', 'main']);
  writeFileSync(join(target, 'seed.txt'), 'seed');
  git(target, ['add', '.']);
  git(target, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'seed']);
  git(target, ['remote', 'add', 'origin', 'https://github.com/' + repo + '.git']);
  const base = git(target, ['rev-parse', 'HEAD']);
  const queue = { target, allowedRepos: [target], acceptedPrerequisites: [], issues: [
    { number: 7, model: 'sol', state: 'ready', dependencies: [], prompt: 'Implement fixture' },
    { number: 8, model: 'sol', state: 'ready', dependencies: [7], prompt: 'Wait for acceptance' }
  ] };
  const inspect = fn => {
    const state = new State(stateDir, { readOnly: true });
    try { return fn(state); } finally { state.close(); }
  };
  const pushes = new Set(), comments = [], pulls = [];
  let loseCreate = false, loseComment = false;
  const api = {
    async issue(_repo, number) {
      return { number, state: 'open', html_url: 'https://github.com/' + repo + '/issues/' + number };
    },
    async viewer() { return 1; },
    async pulls() { return pulls; },
    async create(_repo, { branch, body }) {
      const pull = { number: 12, state: 'open', body, html_url: 'https://github.com/' + repo + '/pull/12',
        head: { sha: [...pushes][0], ref: branch, repo: { full_name: repo } },
        base: { ref: 'main', repo: { full_name: repo } } };
      pulls.push(pull);
      if (loseCreate) throw new Error('lost create response');
      return pull;
    },
    async comments() { return comments; },
    async post(_repo, number, body) {
      const posted = { id: 40, number, body, user: { id: 1 } };
      comments.push(posted);
      if (loseComment) throw new Error('lost issue comment response');
      return posted;
    }
  };
  const publishOptions = { api, push: async (_cwd, _branch, commit) => pushes.add(commit) };
  const executeWith = (worker, overrides) => execute(queue, stateDir, { ...options, ...overrides, publishOptions }, worker);
  return { root, queue, stateDir, target, base, inspect, pulls, comments, pushes, executeWith, publishOptions,
    loseCreate() { loseCreate = true; }, loseComment() { loseComment = true; } };
}

test('publishes a saved verified task without reimplementation and reconciles lost GitHub responses', async t => {
  const f = fixture(t);
  await f.executeWith(async ({ cwd }) => {
    writeFileSync(join(cwd, 'renderer.txt'), 'verified');
    return { state: 'done' };
  });
  const task = f.inspect(state => state.task(7));
  const { tree } = captureVerifiedTree(f.target, f.stateDir, task, ['renderer.txt'], f.base);
  f.queue.publication = { repo, issues: [{ number: 7, paths: ['renderer.txt'],
    verified: { base: f.base, tree, summary: 'Six stills and both missing-font checks passed.' } }] };
  f.loseCreate();
  await f.executeWith(workerForbidden);
  assert.equal(f.pulls.length, 1);
  assert.equal(f.comments.length, 0);
  const commit = f.inspect(state => state.handoff(7).commit_sha);
  f.loseComment();
  await f.executeWith(workerForbidden);
  assert.equal(f.comments.length, 1);
  await f.executeWith(workerForbidden);
  assert.equal(f.inspect(state => state.handoff(7).linked), 1);
  assert.equal(f.inspect(state => state.task(8)), undefined);
  assert.equal(f.inspect(state => state.attempts().length), 1);
  assert.deepEqual([...f.pushes], [commit]);
  assert.equal(git(task.worktree, ['rev-list', '--parents', '-n', '1', 'HEAD']), commit + ' ' + f.base);
  assert.match(f.pulls[0].body, /Related issue: #7[\s\S]*Six stills/);
  assert.match(f.comments[0].body, /pull\/12/);

  git(f.target, ['merge', '--ff-only', task.branch]);
  f.pulls[0].state = 'closed';
  await f.executeWith(workerForbidden);
  f.queue.acceptedPrerequisites = [{ number: 7, commit }];
  const resumed = await f.executeWith(async ({ cwd }) => {
    assert.equal(git(cwd, ['rev-parse', 'HEAD']), commit);
    return { state: 'done' };
  });
  assert.deepEqual(resumed.results.map(row => row.number), [8]);
  assert.equal(f.pulls.length, 1);
});

test('checks the claimed approval before publication and again after a push', async t => {
  const f = fixture(t);
  await f.executeWith(async ({ cwd }) => {
    writeFileSync(join(cwd, 'renderer.txt'), 'verified');
    return { state: 'done' };
  });
  const task = f.inspect(state => state.task(7));
  const { tree } = captureVerifiedTree(f.target, f.stateDir, task, ['renderer.txt'], f.base);
  const policy = publicationPolicy({ repo, issues: [{ number: 7, paths: ['renderer.txt'],
    verified: { base: f.base, tree, summary: 'Verified disposable task.' } }] });
  const state = new State(f.stateDir);
  const publish = authorize => publishVerified({ state, stateDir: f.stateDir, target: f.target, policy,
    number: 7, ...f.publishOptions, authorize });

  try {
    await assert.rejects(publish(async () => false), /original approved intake revision/);
    assert.equal(state.handoff(7), undefined);
    assert.equal(f.pushes.size, 0);

    await assert.rejects(publish(async () => f.pushes.size === 0), /original approved intake revision/);
    assert.equal(f.pushes.size, 1);
    assert.equal(f.pulls.length, 0);
    assert.equal(f.comments.length, 0);
    const commit = state.handoff(7).commit_sha;

    await publish(async () => true);
    assert.equal(state.handoff(7).linked, 1);
    assert.deepEqual([...f.pushes], [commit]);
    assert.equal(f.pulls.length, 1);
    assert.equal(f.comments.length, 1);
  } finally { state.close(); }
});

test('automatically verifies and publishes a recovered task, without releasing its dependent', async t => {
  const f = fixture(t);
  const path = join(f.root, 'verifier.mjs');
  const body = "import {readFileSync} from 'node:fs'; process.exit(readFileSync('renderer.txt','utf8') === 'verified' ? 0 : 10);";
  writeFileSync(path, body);
  f.queue.technicalRecovery = { verifier: { number: 7, path, sha256: createHash('sha256').update(body).digest('hex') } };
  f.queue.publication = { repo, issues: [{ number: 7, paths: ['renderer.txt'] }] };
  const result = await f.executeWith(async ({ cwd }) => {
    writeFileSync(join(cwd, 'renderer.txt'), 'verified');
    return { state: 'blocked', result: { technicalBlocker: 'environment' } };
  });
  assert.deepEqual(result.results.map(row => [row.number, row.state]), [[7, 'blocked'], [7, 'done']]);
  assert.equal(f.inspect(state => state.task(8)), undefined);
  assert.equal(f.inspect(state => state.handoff(7).linked), 1);
  assert.match(f.pulls[0].body, /Approved verification runner exited successfully[\s\S]*Verifier SHA-256/);
});

test('one authorized verification after exhaustion preserves the claim and publishes without a worker', async t => {
  const f = fixture(t);
  const path = join(f.root, 'verifier.mjs');
  const configure = (source, limit = 1) => {
    writeFileSync(path, source);
    f.queue.technicalRecovery = { limit, hostVerification: {
      runner: { path, sha256: createHash('sha256').update(source).digest('hex') },
      profiles: { render: 'Render and decode checks passed.' },
      issues: [{ number: 7, profile: 'render' }]
    } };
  };
  configure('process.exit(11);');
  f.queue.publication = { repo, issues: [{ number: 7, paths: ['renderer.txt'] }] };
  const initial = await f.executeWith(async ({ cwd }) => {
    writeFileSync(join(cwd, 'renderer.txt'), 'reviewed content');
    return { state: 'blocked', result: { technicalBlocker: 'environment' } };
  });
  assert.equal(initial.results.at(-1).detail, 'verification-environment-failure');
  assert.equal(f.inspect(state => state.recoveryRows()[0].hold), 'recovery-budget-exhausted');

  const latest = f.inspect(state => state.attempts().at(-1).id);
  configure("if (orchestratorProfile !== 'render') process.exit(11);");
  const authorization = afterAttempt => ({ limit: 1, finalHostVerification: { number: 7, afterAttempt } });
  assert.deepEqual((await f.executeWith(workerForbidden, authorization(latest + 1))).results, []);
  const result = await f.executeWith(workerForbidden, authorization(latest));
  assert.deepEqual(result.results.map(row => [row.number, row.state]), [[7, 'done']]);
  assert.equal(f.inspect(state => state.recoveryRows()[0].used), 2);
  assert.equal(f.inspect(state => state.attempts().length), 3);
  assert.equal(f.inspect(state => state.handoff(7).linked), 1);
  assert.deepEqual((await f.executeWith(workerForbidden, authorization(latest))).results, []);
  assert.equal(f.pulls.length, 1);
  assert.equal(f.comments.length, 1);
});

test('publication holds if the approved verifier changes the verified source', async t => {
  const f = fixture(t);
  const path = join(f.root, 'verifier.mjs');
  const body = "import {writeFileSync} from 'node:fs'; writeFileSync('renderer.txt','changed by verifier');";
  writeFileSync(path, body);
  f.queue.technicalRecovery = { verifier: { number: 7, path, sha256: createHash('sha256').update(body).digest('hex') } };
  f.queue.publication = { repo, issues: [{ number: 7, paths: ['renderer.txt'] }] };
  const result = await f.executeWith(async ({ cwd }) => {
    writeFileSync(join(cwd, 'renderer.txt'), 'original');
    return { state: 'done' };
  });
  assert.deepEqual(result.results.map(row => [row.state, row.detail]),
    [['blocked', 'verified-worktree-changed-during-verification']]);
  assert.equal(f.inspect(state => state.handoff(7)), undefined);
  assert.equal(f.pushes.size, 0);
});

test('rejects out-of-scope edits and a saved tree that has changed', async t => {
  const f = fixture(t);
  await f.executeWith(async ({ cwd }) => {
    writeFileSync(join(cwd, 'renderer.txt'), 'verified');
    return { state: 'done' };
  });
  const task = f.inspect(state => state.task(7));
  const { tree } = captureVerifiedTree(f.target, f.stateDir, task, ['renderer.txt'], f.base);
  f.queue.publication = { repo, issues: [{ number: 7, paths: ['renderer.txt'],
    verified: { base: f.base, tree, summary: 'Verified.' } }] };
  writeFileSync(join(task.worktree, 'unexpected.txt'), 'outside scope');
  assert.throws(() => captureVerifiedTree(f.target, f.stateDir, task, ['renderer.txt'], f.base), /outside the reviewed scope/);
  rmSync(join(task.worktree, 'unexpected.txt'));
  writeFileSync(join(task.worktree, 'renderer.txt'), 'changed');
  await f.executeWith(workerForbidden);
  assert.equal(f.pulls.length, 0);
  assert.equal(f.pushes.size, 0);
});
