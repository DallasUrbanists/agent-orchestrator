import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Resolve existing ancestors before a missing state directory is created. */
export function resolveStatePath(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    const parent = dirname(path);
    if (error.code !== 'ENOENT' || parent === path) throw error;
    return join(resolveStatePath(parent), basename(path));
  }
}

export function stateDirectory(path) {
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}

export function lease(path) {
  const lock = new DatabaseSync(join(path, 'lease.sqlite'));
  try {
    lock.exec('BEGIN IMMEDIATE');
  } catch (error) {
    lock.close();
    if (error.errcode === 5) throw new Error('Another controller owns this state directory');
    throw error;
  }
  return () => lock.close();
}

export class State {
  constructor(path, { readOnly = false } = {}) {
    this.db = new DatabaseSync(join(path, 'tasks.sqlite'), { readOnly });
    this.db.exec('PRAGMA busy_timeout = 3000;');
    if (readOnly) return;
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS tasks (" +
      "  number INTEGER PRIMARY KEY, target TEXT NOT NULL, worker TEXT NOT NULL, model TEXT NOT NULL," +
      "  state TEXT NOT NULL, worktree TEXT NOT NULL, branch TEXT NOT NULL, log TEXT NOT NULL," +
      "  pid INTEGER, session TEXT, started TEXT NOT NULL, completed TEXT, detail TEXT, exit_code INTEGER," +
      "  retries INTEGER NOT NULL DEFAULT 0, acknowledged INTEGER NOT NULL DEFAULT 0," +
      "  cleaned INTEGER NOT NULL DEFAULT 0);"
    );
  }
  close() { this.db.close(); }
  get(name) {
    return this.db.prepare('SELECT value FROM settings WHERE name = ?').get(name)?.value;
  }
  set(name, value) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(name, value);
  }
  assertBinding(repo, sourceRepo = null) {
    const bound = this.get('repo');
    if (bound === undefined) return;
    if (bound !== repo) throw new Error('This state directory belongs to a different checkout');
    if ((this.get('sourceRepo') ?? null) !== sourceRepo) {
      throw new Error('This state directory belongs to a different task source');
    }
  }
  bind(repo, sourceRepo = null) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.assertBinding(repo, sourceRepo);
      if (this.get('repo') === undefined) {
        this.set('repo', repo);
        if (sourceRepo) this.set('sourceRepo', sourceRepo);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  list() { return this.db.prepare('SELECT * FROM tasks ORDER BY number').all(); }
  task(number) { return this.db.prepare('SELECT * FROM tasks WHERE number = ?').get(number); }

  reserve({ number, repo, worker, model, location, log }) {
    this.db.prepare(
      "INSERT INTO tasks (number, target, worker, model, state, worktree, branch, log, started)" +
      " VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)"
    ).run(number, repo, worker, model, location.path, location.branch, log, new Date().toISOString());
  }
  process(number, { pid, threadId }) {
    this.db.prepare('UPDATE tasks SET pid = coalesce(?, pid), session = coalesce(?, session) WHERE number = ?')
      .run(pid ?? null, threadId ?? null, number);
  }
  finish(number, { state, detail, code }) {
    this.db.prepare('UPDATE tasks SET state = ?, detail = ?, exit_code = ?, completed = ? WHERE number = ?')
      .run(state, detail ?? null, code ?? null, new Date().toISOString(), number);
  }
  recover() {
    this.db.prepare(
      "UPDATE tasks SET state = 'interrupted', detail = 'previous-controller-exited', completed = ?" +
      " WHERE state = 'running'"
    ).run(new Date().toISOString());
  }
  acknowledge(number) {
    const result = this.db.prepare(
      "UPDATE tasks SET acknowledged = 1 WHERE number = ? AND state = 'interrupted'"
    ).run(number);
    if (!result.changes) throw new Error('No interrupted task with that number');
  }
  cleaned(number) {
    this.db.prepare('UPDATE tasks SET cleaned = 1 WHERE number = ?').run(number);
  }
}
