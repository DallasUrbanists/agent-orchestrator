import { randomUUID } from 'node:crypto';
import { copyFileSync, constants, fsyncSync, closeSync, openSync, linkSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { lease } from './state.js';

const snapshotName = /^tasks-[a-f0-9-]{36}\.sqlite$/;

function assertRegular(path) {
  if (!lstatSync(path).isFile() || relative(realpathSync(path), path) !== '') {
    throw new Error('Expected a regular journal file at its recorded path');
  }
}

function backupDirectory(stateDir) {
  const directory = join(stateDir, 'backups');
  mkdirSync(directory, { recursive: true });
  if (relative(realpathSync(directory), directory) !== '') throw new Error('Backup directory redirects elsewhere');
  return directory;
}

function checkSnapshot(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error('SQLite integrity check failed');
}

function publishSnapshot(staging, destination) {
  const file = openSync(staging, 'r+');
  try { fsyncSync(file); } finally { closeSync(file); }
  // A hard link publishes the completed file without replacing an existing file.
  linkSync(staging, destination);
}

function removeStaging(path) {
  try { unlinkSync(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function backupJournal(stateDir) {
  const release = lease(stateDir);
  let staging;
  try {
    const source = join(stateDir, 'tasks.sqlite');
    assertRegular(source);
    const directory = backupDirectory(stateDir);
    const name = 'tasks-' + randomUUID() + '.sqlite';
    staging = join(directory, name + '.partial');
    const live = new DatabaseSync(source, { readOnly: true });
    try { await backup(live, staging); } finally { live.close(); }
    const copy = new DatabaseSync(staging);
    try {
      copy.exec('PRAGMA journal_mode = DELETE');
      checkSnapshot(copy);
      copy.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run('backupStateDir', stateDir);
      copy.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run('control', 'pause');
      copy.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run('restoreHold', 'true');
    } finally { copy.close(); }
    const path = join(directory, name);
    publishSnapshot(staging, path);
    return path;
  } finally {
    try { if (staging) removeStaging(staging); } finally { release(); }
  }
}

export function restoreJournal(stateDir, name) {
  if (typeof name !== 'string' || !snapshotName.test(name) || name !== name.trim()) {
    throw new Error('Specify the snapshot filename printed by backup');
  }
  const release = lease(stateDir);
  let staging;
  try {
    const destination = join(stateDir, 'tasks.sqlite');
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      // lstat also detects dangling links that must not be overwritten.
      try { lstatSync(destination + suffix); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error('Move the existing journal and sidecars to a recovery archive before restoring');
    }
    const snapshot = join(backupDirectory(stateDir), name);
    assertRegular(snapshot);
    staging = join(stateDir, '.restore-' + randomUUID() + '.partial');
    copyFileSync(snapshot, staging, constants.COPYFILE_EXCL);
    const copy = new DatabaseSync(staging, { readOnly: true });
    try {
      checkSnapshot(copy);
      const get = copy.prepare('SELECT value FROM settings WHERE name = ?');
      if (get.get('backupStateDir')?.value !== stateDir ||
          get.get('restoreHold')?.value !== 'true' || get.get('control')?.value !== 'pause') {
        throw new Error('Snapshot belongs to another state directory or lacks the recovery hold');
      }
    } finally { copy.close(); }
    publishSnapshot(staging, destination);
    return destination;
  } finally {
    try { if (staging) removeStaging(staging); } finally { release(); }
  }
}
