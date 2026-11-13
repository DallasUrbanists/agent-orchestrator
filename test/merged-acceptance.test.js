import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { git } from '../src/worktrees.js';
import { acceptedMerge } from '../src/merged-acceptance.js';

test('accepts only the coordinator merge of the verified tree on main', t => {
  const target = mkdtempSync(join(tmpdir(), 'accept-merge-'));
  t.after(() => rmSync(target, {recursive:true,force:true}));
  git(target,['init','-b','main']);
  writeFileSync(join(target,'fixture.txt'),'verified');
  git(target,['add','fixture.txt']);
  git(target,['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','-m','verified']);
  const head = git(target,['rev-parse','HEAD']);
  const repo = {full_name:'fixture/repo'};
  const pull = {number:1,merged:true,merged_by:{id:42},merge_commit_sha:head,
    head:{sha:head,ref:'task',repo},base:{ref:'main',repo}};
  const options = {target,repo:'fixture/repo',base:head,pull:1,head,branch:'task',coordinatorId:42,read:()=>pull};
  assert.equal(acceptedMerge(options),head);
  assert.equal(acceptedMerge({...options,coordinatorId:43}),null);
  pull.head.sha = '0'.repeat(40);
  assert.equal(acceptedMerge(options),null);
});
