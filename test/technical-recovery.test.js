import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findCodex, runCodex } from '../src/codex.js';
import { execute } from '../src/controller.js';
import { State } from '../src/state.js';
import { git } from '../src/worktrees.js';

const blocker = technicalBlocker => ({ state: 'blocked', result: { technicalBlocker } });
const options = { limit: 12, timeoutMs: 30000 };

function fixture(t, verifier) {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'target');
  const stateDir = join(root, 'run');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  writeFileSync(join(repo, 'seed.txt'), 'fixture\n');
  git(repo, ['add', 'seed.txt']);
  const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];
  git(repo, [...identity, 'commit', '-m', 'Seed fixture']);
  const task = (number, dependencies = []) => ({ number, dependencies, state: 'ready', model: 'terra', prompt: 'Fixture #' + number });
  const queue = { target: repo, allowedRepos: [repo], issues: [task(7), task(8, [7]), task(9)],
    acceptedPrerequisites: [], technicalRecovery: { limit: 2 } };
  if (verifier) {
    const path = join(root, 'verifier.mjs');
    writeFileSync(path, verifier);
    queue.technicalRecovery.verifier = { path, sha256: createHash('sha256').update(verifier).digest('hex') };
  }
  const read = callback => {
    const state = new State(stateDir, { readOnly: true });
    try { return callback(state); } finally { state.close(); }
  };
  return { repo, queue, stateDir, identity, read };
}

test('automatically verifies D1-07 environment blockers and repairs a bundler code failure in the saved worktree', async t => {
  const { repo, queue, stateDir, identity, read } = fixture(t, [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) process.exit(11);",
    "const receipt = readFileSync('fixture-receipt.txt', 'utf8');",
    "if (!receipt.includes('Chromium: spawn EPERM') || !receipt.includes('Remotion bundler 4.0.542 missing')) process.exit(11);",
    "writeFileSync('verification-evidence.txt', 'approved verifier reached browser and bundler checks');",
    "if (!existsSync('fixture-renderer.mjs')) process.exit(11);",
    "process.exit(readFileSync('fixture-renderer.mjs', 'utf8').includes('true') ? 0 : 10);"
  ].join('\n'));
  const live = process.env.ORCHESTRATOR_LIVE_RECOVERY === '1';
  const calls = [];
  const executeFixture = (config, runOptions = options) => execute(config, stateDir, runOptions, async worker => {
    const { cwd, prompt } = worker;
    const number = Number(/Fixture #(\d+)/.exec(prompt)[1]);
    calls.push(number);
    if (number === 7 && calls.length === 1) {
      writeFileSync(join(cwd, 'fixture-receipt.txt'), 'Chromium: spawn EPERM\nRemotion bundler 4.0.542 missing\n');
      writeFileSync(join(cwd, 'fixture-renderer.mjs'), 'export const bundle = false;\n');
      return blocker('environment');
    }
    if (number === 7) {
      assert.match(prompt, /bounded repair attempt/);
      assert.match(readFileSync(join(cwd, 'verification-evidence.txt'), 'utf8'), /browser and bundler/);
      assert.match(readFileSync(join(cwd, 'fixture-renderer.mjs'), 'utf8'), /false/);
      if (live) {
        return runCodex({ ...worker, executable: findCodex(), timeoutMs: 120000,
          prompt: prompt + '\nFix fixture-renderer.mjs so bundle is true. Verify by reading the file. Keep all other files unchanged.' });
      }
      writeFileSync(join(cwd, 'fixture-renderer.mjs'), 'export const bundle = true;\n');
    }
    return { state: 'done' };
  });
  const result = await executeFixture(queue);
  assert.deepEqual(result.results.map(row => [row.number, row.state, row.recovery]), [
    [7, 'blocked', undefined], [9, 'done', undefined], [7, 'blocked', 'environment'], [7, 'done', 'code']
  ]);
  assert.deepEqual(calls, [7, 9, 7]);
  const [task, attempts] = read(state => {
    assert.equal(state.task(8), undefined);
    assert.equal(state.recoveryRows()[0].used, 2);
    return [state.task(7), state.attempts().filter(row => row.number === 7)];
  });
  assert.equal(new Set(attempts.map(row => row.base)).size, 1);
  assert.equal(attempts[1].model, 'verification-runner');
  assert.equal(attempts[2].detail, 'verification-passed');
  assert.ok(attempts[1].pid);

  git(task.worktree, ['add', 'fixture-renderer.mjs']);
  git(task.worktree, [...identity, 'commit', '-m', 'Accept fixture 7']);
  git(repo, [...identity, 'merge', '--no-ff', '--no-edit', task.branch]);
  queue.acceptedPrerequisites = [{ number: 7, commit: git(repo, ['rev-parse', 'HEAD']) }];
  const afterMerge = await executeFixture(queue);
  assert.deepEqual(afterMerge.results.map(row => row.number), [8]);
  assert.equal(read(state => state.attempts().at(-1).base), queue.acceptedPrerequisites[0].commit);
});

test('adopts an operator-classified legacy blocker without recreating its worktree', async t => {
  const { queue, stateDir, read } = fixture(t, "import { existsSync } from 'node:fs'; process.exit(existsSync('legacy.txt') ? 0 : 11);");
  queue.issues = [queue.issues[0]];
  const { technicalRecovery, ...legacy } = queue;
  await execute(legacy, stateDir, { ...options, limit: 1 }, async ({ cwd }) => {
    writeFileSync(join(cwd, 'legacy.txt'), 'preserved');
    return { state: 'blocked' };
  });
  const original = read(state => state.task(7));
  technicalRecovery.adopt = [{ number: 7, kind: 'environment' }];
  const result = await execute(queue, stateDir, options, () => assert.fail('environment failure went to a model'));
  assert.deepEqual(result.results.map(row => [row.number, row.state, row.recovery]), [[7, 'done', 'environment']]);
  assert.equal(read(state => state.task(7).worktree), original.worktree);
  assert.equal(readFileSync(join(original.worktree, 'legacy.txt'), 'utf8'), 'preserved');
});

test('a changed verifier fails closed before dispatch', async t => {
  const { queue, stateDir } = fixture(t, 'process.exit(0);');
  writeFileSync(queue.technicalRecovery.verifier.path, 'process.exit(10);');
  await assert.rejects(execute(queue, stateDir, options, () => assert.fail('worker launched')), /changed after approval/);
});

test('recovery retains a prerequisite completed in the issue snapshot', async t => {
  const { queue, stateDir } = fixture(t);
  delete queue.acceptedPrerequisites;
  queue.issues = [
    { ...queue.issues[0], number: 1, state: 'done' },
    { ...queue.issues[0], dependencies: [1] }
  ];
  let calls = 0;
  const result = await execute(queue, stateDir, options, async () => ++calls === 1 ? blocker('code') : { state: 'done' });
  assert.deepEqual(result.results.map(row => [row.number, row.state, row.recovery]),
    [[7, 'blocked', undefined], [7, 'done', 'code']]);
});

test('a technical repair receives every consumed decision instruction', async t => {
  const { queue, stateDir, repo } = fixture(t);
  delete queue.acceptedPrerequisites;
  queue.sourceRepo = 'fixture/decisions';
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/decisions.git']);
  queue.authorizedResponders = [51];
  queue.issues = [{
    ...queue.issues[0],
    decisions: [{ key: 'route', question: 'Which route?', choices: [
      { id: 'local', label: 'Local', instruction: 'Use only the approved local route.' },
      { id: 'other', label: 'Other', instruction: 'Use a different route.' }
    ] }]
  }];
  const at = '2026-01-01T00:00:00Z';
  const comments = [];
  const decisions = {
    ...options, decisionsEnabled: true, readIssues: async () => [{ number: 7, state: 'ready', dependencies: [], model: 'terra' }],
    decisionApi: {
      async viewer() { return 10; },
      async comments() { return comments; },
      async post(_repo, _number, body) {
        const posted = { id: 1, user: { id: 10 }, body, created_at: at };
        comments.push(posted);
        return posted;
      }
    }
  };
  const first = await execute(queue, stateDir, { ...decisions, limit: 1 },
    async () => ({ state: 'blocked', result: { decisionKey: 'route' } }));
  const id = first.results[0].decision;
  comments.push({ id: 2, user: { id: 51, type: 'User' }, body: '/orchestrator decide ' + id + ' local',
    created_at: at, updated_at: at });
  const prompts = [];
  const result = await execute(queue, stateDir, decisions, async ({ prompt }) => {
    prompts.push(prompt);
    return prompts.length === 1 ? blocker('code') : { state: 'done' };
  });
  assert.deepEqual(result.results.map(row => [row.state, row.recovery]), [['blocked', undefined], ['done', 'code']]);
  for (const prompt of prompts) {
    assert.match(prompt, /Use only the approved local route/);
    assert.doesNotMatch(prompt, /Use a different route/);
  }
});

test('durable recovery budget survives a restart and holds dependents after exhaustion', async t => {
  const { queue, stateDir, read } = fixture(t);
  queue.technicalRecovery.limit = 1;
  let calls = 0;
  const worker = async ({ prompt }) => {
    calls++;
    return prompt.includes('Fixture #9') ? { state: 'done' } : blocker('code');
  };
  await execute(queue, stateDir, { ...options, limit: 1 }, worker);
  assert.equal(read(state => state.recoveryRows()[0].used), 0);
  await execute(queue, stateDir, options, worker);
  assert.equal(calls, 3);
  await execute(queue, stateDir, options, () => assert.fail('exhausted task relaunched'));
  assert.equal(read(state => state.recoveryRows()[0].hold), 'recovery-budget-exhausted');
  assert.equal(read(state => state.task(8)), undefined);
});
