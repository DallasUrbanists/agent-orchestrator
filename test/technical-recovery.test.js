import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    queue.technicalRecovery.verifier = { number: 7, path, sha256: createHash('sha256').update(verifier).digest('hex') };
  }
  const read = callback => {
    const state = new State(stateDir, { readOnly: true });
    try { return callback(state); } finally { state.close(); }
  };
  return { repo, queue, stateDir, identity, read };
}

test('project host profiles pick reviewed checks across restarts and distinguish setup from code failures', async t => {
  const { queue, stateDir, read } = fixture(t, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const input = readFileSync('check.txt', 'utf8');",
    "if (orchestratorProfile === 'setup' && input !== 'ready') process.exit(11);",
    "if (orchestratorProfile === 'render' && input !== 'ready') process.exit(10);",
    "writeFileSync('evidence.txt', orchestratorProfile);"
  ].join('\n'));
  const { verifier } = queue.technicalRecovery;
  queue.technicalRecovery = { limit: 2, hostVerification: {
    runner: { path: verifier.path, sha256: verifier.sha256 },
    profiles: { render: 'Render and decode.', setup: 'Verify the pinned host.' },
    issues: [{ number: 7, profile: 'render' }, { number: 9, profile: 'setup' }]
  } };
  const first = await execute(queue, stateDir, { ...options, limit: 1 }, async ({ cwd }) => {
    writeFileSync(join(cwd, 'check.txt'), 'broken');
    return blocker('environment');
  });
  assert.equal(first.results[0].state, 'blocked');
  const repaired = [];
  const next = await execute(queue, stateDir, options, async ({ cwd, prompt }) => {
    if (prompt.endsWith('Fixture #9')) {
      writeFileSync(join(cwd, 'check.txt'), 'not installed');
      return { state: 'done' };
    }
    assert.match(prompt, /bounded repair/);
    assert.equal(readFileSync(join(cwd, 'check.txt'), 'utf8'), 'broken');
    repaired.push(cwd);
    writeFileSync(join(cwd, 'check.txt'), 'ready');
    return blocker('environment');
  });
  assert.deepEqual(next.results.filter(row => row.number === 7).map(row => row.detail),
    ['verification-code-failure', 'verification-passed']);
  assert.ok(next.results.filter(row => row.number === 9).every(row => row.detail === 'verification-environment-failure'));
  assert.equal(repaired.length, 1);
  assert.equal(readFileSync(join(repaired[0], 'evidence.txt'), 'utf8'), 'render');
  assert.equal(read(state => state.task(8)), undefined);
  assert.deepEqual((await execute(queue, stateDir, options, () => assert.fail('duplicate work'))).results, []);
});

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

test('an issue-specific verifier cannot complete another issue with the same blocker', async t => {
  const { queue, stateDir, read } = fixture(t, 'process.exit(0);');
  const result = await execute(queue, stateDir, options, async () => blocker('environment'));
  assert.deepEqual(result.results.map(row => [row.number, row.state, row.recovery]),
    [[7, 'blocked', undefined], [9, 'blocked', undefined], [7, 'done', 'environment']]);
  assert.equal(read(state => state.recoveryRows().find(row => row.number === 9).hold), 'verification-runner-required');
  assert.equal(read(state => state.task(8)), undefined);
});

test('a missing or changed verifier holds one issue without spending its retry or stopping the queue', async t => {
  const approved = 'process.exit(0);';
  const { queue, stateDir, read } = fixture(t, approved);
  const { path } = queue.technicalRecovery.verifier;
  rmSync(path);
  const runs = [];
  const first = await execute(queue, stateDir, options, async ({ prompt }) => {
    const number = Number(/Fixture #(\d+)/.exec(prompt)[1]);
    runs.push(number);
    return number === 7 ? blocker('environment') : { state: 'done' };
  });
  assert.deepEqual(first.results.map(row => row.number), [7, 9]);
  assert.deepEqual(runs, [7, 9]);
  const hold = () => read(state => state.recoveryRows()[0]);
  assert.equal(hold().used, 0);
  assert.equal(hold().hold, 'verification-runner-unavailable');
  writeFileSync(path, 'process.exit(10);');
  await execute(queue, stateDir, options, () => assert.fail('unexpected worker'));
  assert.equal(hold().used, 0);
  assert.equal(hold().hold, 'verification-runner-unavailable');
  writeFileSync(path, approved);
  const recovery = await execute(queue, stateDir, options, () => assert.fail('environment blocker used Codex'));
  assert.deepEqual(recovery.results.map(row => [row.number, row.state]), [[7, 'done']]);
  assert.equal(hold().used, 1);
  assert.equal(read(state => state.task(8)), undefined);
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

test('Windows stop terminates the verifier process tree and preserves the blocked worktree', {
  skip: process.platform !== 'win32', timeout: 25000
}, async t => {
  const { queue, stateDir, read } = fixture(t, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    "child.once('spawn', () => writeFileSync('verifier-child.pid', String(child.pid)));",
    "setInterval(() => {}, 1000);"
  ].join('\n'));
  await execute(queue, stateDir, { ...options, limit: 1 }, async ({ cwd }) => {
    writeFileSync(join(cwd, 'partial.txt'), 'pending review');
    return blocker('environment');
  });
  const claim = read(state => state.task(7));
  const marker = join(claim.worktree, 'verifier-child.pid');
  const abort = new AbortController();
  let pid;
  const run = execute(queue, stateDir, { ...options, timeoutMs: 9000, signal: abort.signal },
    async ({ prompt }) => {
      assert.match(prompt, /Fixture #9/);
      return { state: 'done' };
    });
  try {
    for (let i = 0; i < 100 && !existsSync(marker); i++) await delay(40);
    assert.ok(existsSync(marker), 'verifier did not start its child');
    pid = Number(readFileSync(marker, 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    process.kill(pid, 0);
    const stop = execFileSync(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)),
      'stop', '--state', stateDir], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    assert.equal(JSON.parse(stop).control, 'stop');
    const result = await run;
    assert.deepEqual(result.results.map(row => [row.number, row.state]), [[9, 'done'], [7, 'stopped']]);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    pid = undefined;
    assert.equal(readFileSync(join(claim.worktree, 'partial.txt'), 'utf8'), 'pending review');
    assert.equal(read(state => state.task(8)), undefined);
    assert.equal(read(state => state.attempts().at(-1).state), 'stopped');
    assert.throws(() => process.kill(read(state => state.attempts().at(-1).pid), 0), { code: 'ESRCH' });
    const restarted = await execute(queue, stateDir, options, () => assert.fail('dispatch after stop'));
    assert.equal(restarted.reason, 'stop');
  } finally {
    abort.abort();
    await run.catch(() => {});
    if (pid) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
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

test('resumes a pre-implementation environment blocker once in the original worktree and verifies it', async t => {
  const { queue, stateDir, read } = fixture(t, [
    "import { readFileSync } from 'node:fs';",
    "if (readFileSync('implementation.txt', 'utf8') !== 'ready') process.exit(10);",
    "console.log(JSON.stringify([{name:'fixture-check',measurements:{tests:1}}]));"
  ].join('\n'));
  let original;
  await execute(queue, stateDir, { ...options, limit: 1 }, async ({ cwd }) => {
    original = cwd;
    writeFileSync(join(cwd, 'receipt.txt'), 'sandbox tool unavailable');
    return blocker('environment');
  });
  const { verifier: runner } = queue.technicalRecovery;
  queue.technicalRecovery = { limit: 2, hostVerification: {
    runner, profiles: { render: 'Verify fixture.' },
    issues: [{ number: 7, profile: 'render', resumeImplementation: true }]
  } };
  const resumed = await execute(queue, stateDir, options, async ({ cwd, prompt }) => {
    if (prompt.endsWith('Fixture #9')) return { state: 'done' };
    assert.match(prompt, /Resume implementation/);
    assert.equal(cwd, original);
    assert.equal(readFileSync(join(cwd, 'receipt.txt'), 'utf8'), 'sandbox tool unavailable');
    writeFileSync(join(cwd, 'implementation.txt'), 'ready');
    return blocker('environment');
  });
  assert.deepEqual(resumed.results.map(({ number, detail }) => [number, detail]),
    [[9, undefined], [7, 'verification-passed']]);
  assert.equal(read(state => state.task(8)), undefined);
  assert.deepEqual((await execute(queue, stateDir, options, () => assert.fail('duplicate work'))).results, []);
});

test('dispatches a Gate B fixture-loading blocker once after ordinary recovery is exhausted', async t => {
  const { queue, stateDir, read } = fixture(t, [
    "import { existsSync } from 'node:fs';",
    "if (!existsSync('bridge-style.json')) { console.error('Gate B: bridge-style.json returned 404'); process.exit(10); }",
    "console.log(JSON.stringify([{name:'fixture-load',measurements:{checks:1}}]));"
  ].join('\n'));
  const { verifier: runner } = queue.technicalRecovery;
  queue.technicalRecovery = { limit: 1, hostVerification: {
    runner, profiles: { gate: 'Gate B fixture loads.' }, issues: [{ number: 7, profile: 'gate' }]
  } };
  let original;
  await execute(queue, stateDir, options, async ({ cwd, prompt }) => {
    if (prompt.endsWith('Fixture #7')) original = cwd;
    return { state: 'done' };
  });
  const afterAttempt = read(state => state.attempts().filter(row => row.number === 7).at(-1).id);
  assert.equal(read(state => state.recoveryRows().find(row => row.number === 7).hold), 'recovery-budget-exhausted');
  const assignment = { number: 7, afterAttempt, instruction: 'Restore only the missing Gate B bridge-style.json fixture.' };
  queue.technicalRecovery.blockerTasks = [{ ...assignment, afterAttempt: afterAttempt - 1 }];
  assert.deepEqual((await execute(queue, stateDir, options, () => assert.fail('stale assignment'))).results, []);
  queue.technicalRecovery.blockerTasks = [assignment];
  const result = await execute(queue, stateDir, options, async ({ cwd, prompt }) => {
    assert.equal(cwd, original);
    assert.match(prompt, /Restore only the missing Gate B/);
    writeFileSync(join(cwd, 'bridge-style.json'), '{}');
    return { state: 'done' };
  });
  assert.deepEqual(result.results.map(row => row.detail), ['verification-passed']);
  assert.equal(read(state => state.task(8)), undefined);
  assert.deepEqual((await execute(queue, stateDir, options, () => assert.fail('duplicate repair'))).results, []);
});
