import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hasMergeConflict, repairPull, reconcileRepairedThreads } from '../src/merge-conflict.js';
import { git } from '../src/worktrees.js';

test('detects conflicts between exact commits without changing the checkout', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'orchestrator-conflict-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, ['init', '-b', 'main']);
  const commit = value => {
    writeFileSync(join(cwd, 'fixture.txt'), value);
    git(cwd, ['add', 'fixture.txt']);
    git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-m', value]);
    return git(cwd, ['rev-parse', 'HEAD']);
  };
  const seed = commit('seed');
  git(cwd, ['switch', '-c', 'task']);
  const head = commit('task');
  git(cwd, ['switch', 'main']);
  const base = commit('main');
  assert.equal(hasMergeConflict(cwd, head, seed), false);
  assert.equal(hasMergeConflict(cwd, head, base), true);
  assert.throws(() => hasMergeConflict(cwd, head, '0'.repeat(40)), /Could not determine/);
  assert.equal(git(cwd, ['rev-parse', 'HEAD']), base);
  assert.equal(git(cwd, ['status', '--porcelain']), '');
});

test('repairs and verifies a conflict before pushing the same task branch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-pr-repair-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), remote = join(root, 'remote'), stateDir = join(root, 'state');
  for (const dir of [repo, remote, stateDir, join(stateDir, 'logs')]) mkdirSync(dir);
  git(repo, ['init', '-b', 'main']);
  git(remote, ['init', '--bare']);
  git(repo, ['remote', 'add', 'origin', remote]);
  const commit = value => {
    writeFileSync(join(repo, 'fixture.txt'), value);
    git(repo, ['add', 'fixture.txt']);
    git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-m', value]);
    return git(repo, ['rev-parse', 'HEAD']);
  };
  commit('seed');
  git(repo, ['switch', '-c', 'task']);
  const head = commit('task');
  git(repo, ['switch', 'main']);
  const base = commit('main');
  git(repo, ['push', 'origin', 'main', 'task', 'task:refs/pull/1/head']);
  const pull = {state:'OPEN', headRefName:'task', headRefOid:head, baseRefName:'main', baseRefOid:base,
    mergeable:'CONFLICTING', reviewThreads:{pageInfo:{hasNextPage:false},nodes:[]}};
  const state = new Map();
  let launches = 0;
  const opts = { state, stateDir, target:repo, repo:'example/fixture', task:{branch:'task'},
    receipt:{pull:1,commit_sha:head}, entry:{paths:['fixture.txt']}, issue:{model:'terra'},
    reviewers:[], lookup:()=>pull, checkOrigin:()=>{}, authorized:()=>true, timeoutMs:30000,
    verifier:Buffer.from("import {readFileSync} from 'node:fs'; if(readFileSync('fixture.txt','utf8') !== 'task and main') process.exit(10); console.log(JSON.stringify([{name:'fixture',measurements:{tests:1}}]));"),
    worker:async ({cwd}) => {
      launches++;
      assert.equal(git(cwd,['diff','--name-only','--diff-filter=U']), 'fixture.txt');
      writeFileSync(join(cwd,'fixture.txt'),'task and main');
      return {state:'done'};
    }
  };
  const set = state.set.bind(state);
  state.set = (key, value) => {
    if (value.startsWith('published:')) throw new Error('journal write interrupted');
    return set(key, value);
  };
  await assert.rejects(repairPull(opts), /journal write interrupted/);
  assert.match(state.get('pullRepair:1'), /^verified:/);
  state.set = set;
  await repairPull(opts);
  const repaired = git(remote,['rev-parse','refs/heads/task']);
  assert.equal(git(remote,['rev-list','--parents','-1',repaired]), [repaired,head,base].join(' '));
  assert.equal(state.get('pullRepair:1'), 'published:'+repaired);
  await repairPull(opts);
  assert.equal(launches,1);

  // A legacy round may have recorded a thread before its worker blocked.
  const review = { id: 'review-1', path: 'fixture.txt', isResolved: false,
    comments: { nodes: [{ author: { login: 'reviewer' }, body: 'Correct the fixture.' }] } };
  pull.headRefOid = repaired;
  pull.mergeable = 'MERGEABLE';
  pull.reviewThreads.nodes = [review];
  git(repo, ['push', 'origin', repaired + ':refs/pull/1/head']);
  state.clear();
  state.set('pullRepair:1:rounds', JSON.stringify([{ threads: [review.id], conflict: null }]));
  let followups = 0;
  const retry = { ...opts, reviewers: ['reviewer'], verifier: Buffer.from('process.exit(0)'),
    worker: async ({ cwd, prompt }) => {
      followups++;
      assert.match(prompt, /Correct the fixture/);
      writeFileSync(join(cwd, 'fixture.txt'), 'reviewed fix');
      return { state: 'done' };
    } };
  await repairPull(retry);
  const reviewed = git(remote, ['rev-parse', 'refs/heads/task']);
  assert.notEqual(reviewed, repaired);
  assert.equal(state.get('pullRepair:1:published-thread:' + review.id), reviewed);
  await repairPull(retry);
  assert.equal(followups, 1);
});

test('resolves only threads recorded for the current verified repair and reconciles lost responses', async () => {
  const head = 'a'.repeat(40);
  const state = new Map([['pullRepair:1', 'published:' + head],
    ['pullRepair:1:published-thread:fixed', head]]);
  const thread = id => ({ id, isResolved: false, isOutdated: false,
    comments: { nodes: [{ author: { login: 'reviewer' } }] } });
  const fixed = thread('fixed');
  const pull = { state: 'OPEN', headRefName: 'task', headRefOid: 'b'.repeat(40), baseRefName: 'main',
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [fixed, thread('unrelated')] } };
  const calls = [];
  const options = { state, repo: 'example/fixture', number: 1, branch: 'task', head,
    reviewers: ['reviewer'], lookup: () => pull, api: { async resolveThread(id) {
      calls.push(id);
      fixed.isResolved = true;
      throw new Error('response lost');
    } } };
  await reconcileRepairedThreads(options);
  assert.deepEqual(calls, []);
  pull.headRefOid = head;
  await assert.rejects(reconcileRepairedThreads(options), /response lost/);
  await reconcileRepairedThreads(options);
  fixed.isResolved = false;
  await reconcileRepairedThreads(options);
  assert.deepEqual(calls, ['fixed']);

  const descendant = 'c'.repeat(40);
  state.set('pullRepair:1', 'published:' + descendant);
  state.set('pullRepair:1:published-thread:unrelated', head);
  pull.headRefOid = descendant;
  const resolveThread = async id => {
    calls.push(id);
    return { id, isResolved: true };
  };
  await reconcileRepairedThreads({ ...options, head: descendant, api: { resolveThread },
    isAncestor: (commit, current) => commit === head && current === descendant });
  assert.deepEqual(calls, ['fixed', 'unrelated']);
  assert.equal(state.get('pullRepair:1:confirmed-thread:unrelated'), descendant);

});
