import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { execute, preview } from '../src/controller.js';
import { lease, State, stateDirectory } from '../src/state.js';
import { git, worktreeLocation } from '../src/worktrees.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const run = (stateDir, ...args) => spawnSync(process.execPath, [cli, ...args, '--state', stateDir], {
  encoding: 'utf8', windowsHide: true, timeout: 10000
});
function success(stateDir, ...args) {
  const result = run(stateDir, ...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('restores a stopped controller journal and holds dispatch until reconciliation', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'orchestrator-backup-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const stateDir = stateDirectory(join(scratch, 'state'));
  const repo = stateDirectory(join(scratch, 'repo'));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Seed']);
  const queue = { target: repo, allowedRepos: [repo], issues: [1, 2, 3].map(number => ({
    number, title: 'Fixture task', model: 'terra', state: 'ready', dependencies: [], prompt: 'Local fixture'
  })) };
  await execute(queue, stateDir, { executable: 'fixture', limit: 1 }, async () => ({ state: 'done' }));
  const store = new State(stateDir);
  try {
    store.reserve({ number: 2, repo, worker: 'local-1', model: 'gpt-6.1-terra',
      location: worktreeLocation(stateDir, 2), log: 'fixture' });
    store.finish(2, { state: 'blocked' }, { id: 'decision-fixture', key: 'check', template: {} });
    store.answerDecision('decision-fixture', { comment: 12, author: 7, choice: 'yes' });
  } finally { store.close(); }

  const unlock = lease(stateDir);
  try { assert.match(run(stateDir, 'backup').stderr, /Another controller owns/); }
  finally { unlock(); }
  const { snapshot } = success(stateDir, 'backup');
  assert.ok(existsSync(snapshot));
  assert.equal(success(stateDir, 'status').control, 'running');
  assert.match(run(stateDir, 'restore', basename(snapshot)).stderr, /archive before restoring/);

  const other = stateDirectory(join(scratch, 'other'));
  mkdirSync(join(other, 'backups'));
  copyFileSync(snapshot, join(other, 'backups', basename(snapshot)));
  assert.match(run(other, 'restore', basename(snapshot)).stderr, /belongs to another state directory/);
  assert.equal(existsSync(join(other, 'tasks.sqlite')), false);
  const corrupt = 'tasks-00000000-0000-0000-0000-000000000001.sqlite';
  writeFileSync(join(other, 'backups', corrupt), 'not SQLite');
  assert.equal(run(other, 'restore', corrupt).status, 1);
  assert.equal(existsSync(join(other, 'tasks.sqlite')), false);
  assert.equal(run(other, 'restore', '../' + basename(snapshot)).status, 1);

  const journal = join(stateDir, 'tasks.sqlite');
  renameSync(journal, join(scratch, 'archived.sqlite'));
  await assert.rejects(execute(queue, stateDir, { executable: 'fixture' },
    () => assert.fail('missing journal dispatched work')), /state journal is missing/);
  assert.match(run(stateDir, 'status').stderr, /state journal is missing/);
  await assert.rejects(preview(queue, stateDir), /state journal is missing/);
  assert.equal(existsSync(journal), false);
  writeFileSync(journal + '-wal', '');
  assert.match(run(stateDir, 'restore', basename(snapshot)).stderr, /archive before restoring/);
  renameSync(journal + '-wal', join(scratch, 'archived.sqlite-wal'));
  assert.equal(success(stateDir, 'restore', basename(snapshot)).reconciliationRequired, true);
  const status = success(stateDir, 'status');
  assert.equal(status.control, 'pause');
  assert.equal(status.reconciliationRequired, true);
  assert.deepEqual(status.tasks.map(row => [row.number, row.state]), [[1, 'done'], [2, 'blocked']]);
  assert.equal(status.decisions[0].reply_comment, 12);
  assert.equal((await preview(queue, stateDir)).reason, 'restored-state-needs-reconciliation');
  assert.deepEqual(await execute(queue, stateDir, { executable: 'fixture', limit: 3 },
    () => assert.fail('restore hold failed')), { reason: 'restored-state-needs-reconciliation', results: [] });
  assert.match(run(stateDir, 'unpause').stderr, /confirm-reconciled/);
  success(stateDir, 'unpause', '--confirm-reconciled');
  const result = await execute(queue, stateDir, { executable: 'fixture', limit: 3 }, async () => ({ state: 'done' }));
  assert.deepEqual(result.results.map(row => row.number), [3]);
});
