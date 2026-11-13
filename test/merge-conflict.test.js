import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hasMergeConflict, repairPull } from '../src/merge-conflict.js';
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
});
