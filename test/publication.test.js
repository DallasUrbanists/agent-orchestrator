import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

test('legacy handoff reopens finished recovery without resetting its budget', async t => {
  const f = fixture(t);
  await f.executeWith(async () => ({ state: 'done' }));
  const state = new State(f.stateDir);
  try {
    state.db.prepare("INSERT INTO technical_recovery VALUES (7, 'code', 'old-scope', 1, 'finished')").run();
    state.reconcileUnverifiedHandoff(7, 'approved-scope');

    const expected = { number: 7, kind: 'environment', scope: 'approved-scope', used: 1, hold: null };
    assert.deepEqual({ ...state.recoveryRows()[0] }, expected);
    assert.equal(state.task(7).state, 'blocked');
    assert.equal(state.attempts().length, 1);
    state.reconcileUnverifiedHandoff(7, 'different-scope');
    assert.deepEqual({ ...state.recoveryRows()[0] }, expected);
  } finally { state.close(); }
});

test('explicit adoption retries rejected host evidence without reimplementation', async t => {
  const f = fixture(t);
  const path = join(f.root, 'verifier.mjs');
  const configure = evidence => {
    const code = 'console.log(' + JSON.stringify(evidence) + ');';
    writeFileSync(path, code);
    f.queue.technicalRecovery = { limit: 4, adopt: [{ number: 7, kind: 'environment' }], hostVerification: {
      runner: { path, sha256: createHash('sha256').update(code).digest('hex') },
      profiles: { schema: 'Reviewed checks.' }, issues: [{ number: 7, profile: 'schema' }]
    } };
  };
  f.queue.publication = { repo, issues: [{ number: 7, paths: ['renderer.txt'] }] };
  configure('invalid');
  await f.executeWith(async ({ cwd }) => {
    writeFileSync(join(cwd, 'renderer.txt'), 'verified');
    return { state: 'blocked', result: { technicalBlocker: 'environment' } };
  }, { limit: 2 });
  assert.equal(f.inspect(state => state.task(7).detail), 'invalid-verification-evidence');
  await f.executeWith(workerForbidden);
  await f.executeWith(workerForbidden);
  assert.equal(f.inspect(state => state.attempts().length), 3);
  configure(JSON.stringify([{ name: 'schema', measurements: { tests: 9 } }]));
  await f.executeWith(workerForbidden);
  assert.equal(f.inspect(state => state.handoff(7).linked), 1);
  assert.equal(f.inspect(state => state.attempts().length), 4);
});

test('a verified attempt stays pending across restart until its PR link is recorded', async t => {
  const f = fixture(t);
  const path = join(f.root, 'verifier.mjs');
  const body = 'process.exit(0);';
  writeFileSync(path, body);
  f.queue.technicalRecovery = { verifier: { number: 7, path, sha256: createHash('sha256').update(body).digest('hex') } };
  f.queue.publication = { repo, issues: [{ number: 7, paths: ['renderer.txt'] }] };
  const api = f.publishOptions.api;
  const listPulls = api.pulls;
  api.pulls = async () => { throw new Error('GitHub unavailable'); };
  await f.executeWith(async ({ cwd }) => {
    writeFileSync(join(cwd, 'renderer.txt'), 'verified');
    return { state: 'done' };
  });
  assert.equal(f.inspect(state => state.task(7).state), 'awaiting-handoff');
  assert.equal(f.inspect(state => state.attempts()[0].state), 'awaiting-handoff');
  assert.equal(f.inspect(state => state.handoff(7).linked), 0);

  api.pulls = listPulls;
  await f.executeWith(workerForbidden);
  assert.equal(f.inspect(state => state.task(7).state), 'done');
  assert.equal(f.inspect(state => state.attempts()[0].state), 'done');
  assert.equal(f.inspect(state => state.attempts().length), 1);
  assert.equal(f.inspect(state => state.task(8)), undefined);
  assert.equal(f.pulls.length, 1);
  assert.equal(f.comments.length, 1);
});

test('reuses one model slot while the first task waits for host verification', async t => {
  const f = fixture(t);
  const ready = join(f.root, 'verifying');
  const release = join(f.root, 'release');
  const path = join(f.root, 'verifier.mjs');
  const body = "import {existsSync,writeFileSync} from 'node:fs'; import {setTimeout as delay} from 'node:timers/promises'; " +
    'writeFileSync(' + JSON.stringify(ready) + ', "started"); ' +
    'for (let i = 0; i < 200 && !existsSync(' + JSON.stringify(release) + '); i++) await delay(25); ' +
    'if (!existsSync(' + JSON.stringify(release) + ')) process.exit(10);';
  writeFileSync(path, body);
  f.queue.technicalRecovery = { verifier: { number: 7, path, sha256: createHash('sha256').update(body).digest('hex') } };
  f.queue.publication = { repo, issues: [{ number: 7, paths: ['renderer.txt'] }] };
  f.queue.issues.push({ number: 9, model: 'sol', state: 'ready', dependencies: [], prompt: 'Independent fixture' });
  let observed = false;
  await f.executeWith(async ({ cwd, prompt }) => {
    if (prompt.includes('Independent fixture')) {
      const { setTimeout: delay } = await import('node:timers/promises');
      for (let i = 0; i < 80 && !existsSync(ready); i++) await delay(25);
      observed = existsSync(ready) && f.inspect(state => state.task(7).state) === 'running';
      writeFileSync(release, 'continue');
    } else {
      writeFileSync(join(cwd, 'renderer.txt'), 'verified');
    }
    return { state: 'done' };
  });
  assert.equal(observed, true);
  assert.equal(f.inspect(state => state.handoff(7).linked), 1);
  assert.equal(f.inspect(state => state.task(8)), undefined);
});

test('dispatches independent work while GitHub publication is pending', async t => {
  const f = fixture(t);
  const path = join(f.root, 'verifier.mjs');
  const body = 'process.exit(0);';
  writeFileSync(path, body);
  f.queue.technicalRecovery = { verifier: { number: 7, path, sha256: createHash('sha256').update(body).digest('hex') } };
  f.queue.publication = { repo, issues: [{ number: 7, paths: ['renderer.txt'] }] };
  f.queue.issues.push({ number: 9, model: 'sol', state: 'ready', dependencies: [], prompt: 'Independent fixture' });
  f.publishOptions.api.pulls = async () => { throw new Error('GitHub unavailable'); };
  await f.executeWith(async ({ cwd }) => {
    writeFileSync(join(cwd, 'renderer.txt'), 'verified');
    return { state: 'done' };
  }, { limit: 1 });
  const result = await f.executeWith(async ({ prompt }) => {
    assert.match(prompt, /Independent fixture/);
    assert.equal(f.inspect(state => state.task(7).state), 'awaiting-handoff');
    assert.equal(f.inspect(state => state.handoff(7).linked), 0);
    return { state: 'done' };
  });
  assert.deepEqual(result.results.map(({ number, state }) => [number, state]), [[9, 'done']]);
  assert.equal(f.inspect(state => state.task(8)), undefined);
});

test('matches an approved host profile for a saved blocker after restart and rechecks a repair', async t => {
  const f = fixture(t);
  const path = join(f.root, 'verifier.mjs');
  const body = "import {readFileSync} from 'node:fs'; if (orchestratorProfile !== 'schema') process.exit(11); if (readFileSync('renderer.txt','utf8') !== 'fixed') process.exit(10);";
  writeFileSync(path, body);
  f.queue.publication = { repo, issues: [{ number: 7, paths: ['renderer.txt'] }] };
  f.queue.technicalRecovery = { limit: 4, hostVerification: {
    runner: { path, sha256: createHash('sha256').update(body).digest('hex') },
    profiles: { schema: 'Reviewed schema checks.', alternate: 'Other checks.' }, issues: [],
    rules: [{ profile: 'schema', blockers: ['environment', 'code'], paths: ['renderer.txt'] }]
  } };
  await f.executeWith(async ({ cwd }) => {
    writeFileSync(join(cwd, 'renderer.txt'), 'broken');
    return { state: 'blocked', result: { technicalBlocker: 'environment' } };
  }, { limit: 1 });
  const original = f.inspect(state => state.task(7).worktree);
  const rules = f.queue.technicalRecovery.hostVerification.rules;
  rules.push({ ...rules[0], profile: 'alternate' });
  await f.executeWith(workerForbidden);
  assert.equal(f.inspect(state => state.recoveryRows()[0].hold), 'verification-profile-ambiguous');
  assert.equal(f.inspect(state => state.attempts().length), 1);
  rules.pop();
  const resumed = await f.executeWith(async ({ cwd, prompt }) => {
    assert.equal(cwd, original);
    assert.match(prompt, /bounded repair/);
    writeFileSync(join(cwd, 'renderer.txt'), 'fixed');
    return { state: 'done' };
  });
  assert.deepEqual(resumed.results.map(row => row.detail), ['verification-code-failure', 'verification-passed']);
  assert.equal(f.inspect(state => state.handoff(7).linked), 1);
  assert.equal(f.inspect(state => state.task(8)), undefined);
});

test('publishes measured profile checks and holds malformed verifier evidence', async t => {
  for (const valid of [true, false]) {
    const f = fixture(t);
    const path = join(f.root, 'verifier.mjs');
    const output = valid ? [{ name: 'portrait', measurements: { width: 1080, frames: 300 } }]
      : [{ name: 'portrait', measurements: { output: 'private machine path' } }];
    const code = 'process.stdout.write(' + JSON.stringify(JSON.stringify(output)) + ');';
    writeFileSync(path, code);
    f.queue.technicalRecovery = { hostVerification: {
      runner: { path, sha256: createHash('sha256').update(code).digest('hex') },
      profiles: { render: 'Check the rendered fixture.' },
      issues: [{ number: 7, profile: 'render' }]
    } };
    f.queue.publication = { repo, issues: [{ number: 7, paths: ['renderer.txt'] }] };
    const result = await f.executeWith(async ({ cwd }) => {
      writeFileSync(join(cwd, 'renderer.txt'), 'verified');
      return { state: 'done' };
    });
    if (valid) {
      assert.match(f.pulls[0].body, /Measured checks[\s\S]*portrait — width 1080, frames 300/);
      assert.match(f.inspect(state => state.handoff(7).evidence), /frames 300/);
    } else {
      assert.equal(result.results[0].detail, 'invalid-verification-evidence');
      assert.equal(f.inspect(state => state.handoff(7)), undefined);
      assert.equal(f.pushes.size, 0);
    }
  }
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
  assert.equal(f.comments.length, 2);
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

test('review request reconciles an ambiguous delivery and requests the next head once', async () => {
  const { requestCodexReview } = await import('../src/publication.js');
  const state = new Map(), comments = [];
  const repo = 'fixture/repo', branch = 'task';
  let head = 'a'.repeat(40);
  const api = {
    viewer: async () => 1,
    pulls: async () => [{number:1,state:'open',head:{ref:branch,sha:head,repo:{full_name:repo}},
      base:{ref:'main',repo:{full_name:repo}}}],
    comments: async () => comments,
    post: async (_repo, _number, body) => {
      const comment = {id:comments.length+1,user:{id:1},body};
      comments.push(comment);
      if (comment.id === 1) throw new Error('response lost');
      return comment;
    }
  };
  const request = journal => requestCodexReview(journal, repo, 1, branch, head, {}, api);
  await assert.rejects(request(state), /response lost/);
  const restarted = new Map(state);
  await request(restarted);
  await request(restarted);
  assert.equal(comments.length, 1);
  head = 'b'.repeat(40);
  await request(restarted);
  await request(restarted);
  assert.equal(comments.length, 2);
  assert.match(comments[1].body, /^@codex review\n/);
  assert.ok(comments[1].body.includes(head));
});
