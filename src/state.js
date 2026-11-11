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
      "  cleaned INTEGER NOT NULL DEFAULT 0);" +
      "CREATE TABLE IF NOT EXISTS decisions (" +
      "  id TEXT PRIMARY KEY, number INTEGER NOT NULL, decision_key TEXT NOT NULL, template TEXT NOT NULL," +
      "  requested TEXT NOT NULL, publisher_id INTEGER, posting INTEGER NOT NULL DEFAULT 0," +
      "  request_comment INTEGER, reply_comment INTEGER, responder_id INTEGER, choice TEXT," +
      "  answered TEXT, consumed TEXT, last_error TEXT, UNIQUE(number, decision_key));"
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
  transaction(update) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = update();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  bind(repo, sourceRepo = null) {
    this.transaction(() => {
      this.assertBinding(repo, sourceRepo);
      if (this.get('repo') === undefined) {
        this.set('repo', repo);
        if (sourceRepo) this.set('sourceRepo', sourceRepo);
      }
    });
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
  finish(number, { state, detail, code }, decision = null) {
    const completed = new Date().toISOString();
    const finishTask = () => this.db.prepare(
      'UPDATE tasks SET state = ?, detail = ?, exit_code = ?, completed = ? WHERE number = ?'
    ).run(state, detail ?? null, code ?? null, completed, number);
    if (!decision) return finishTask();
    this.transaction(() => {
      finishTask();
      this.db.prepare('INSERT INTO decisions (id, number, decision_key, template, requested) VALUES (?, ?, ?, ?, ?)')
        .run(decision.id, number, decision.key, JSON.stringify(decision.template), completed);
    });
  }

  decisionStatus() {
    return this.db.prepare(
      'SELECT id, number, decision_key, requested, posting, request_comment, reply_comment,' +
      ' responder_id, choice, answered, consumed, last_error FROM decisions ORDER BY requested, id'
    ).all();
  }
  decisionKeys(number) {
    return this.db.prepare('SELECT decision_key FROM decisions WHERE number = ?').all(number).map(row => row.decision_key);
  }
  pendingDecisions() {
    return this.db.prepare(
      "SELECT decisions.* FROM decisions JOIN tasks USING (number)" +
      " WHERE tasks.state = 'blocked' AND decisions.consumed IS NULL ORDER BY requested, id"
    ).all();
  }
  decisionError(id, error) {
    this.db.prepare('UPDATE decisions SET last_error = ? WHERE id = ?').run(error, id);
  }
  beginDecisionPost(id, publisher) {
    this.db.prepare('UPDATE decisions SET publisher_id = ?, posting = 1 WHERE id = ?').run(publisher, id);
  }
  decisionPosted(id, comment) {
    this.db.prepare('UPDATE decisions SET posting = 0, request_comment = ?, last_error = NULL WHERE id = ?')
      .run(comment, id);
  }
  answerDecision(id, { comment, author, choice }) {
    this.db.prepare(
      'UPDATE decisions SET reply_comment = ?, responder_id = ?, choice = ?, answered = ?, last_error = NULL' +
      ' WHERE id = ? AND reply_comment IS NULL'
    ).run(comment, author, choice, new Date().toISOString(), id);
  }
  retryDecision(id) {
    const result = this.db.prepare(
      "UPDATE decisions SET posting = 0, last_error = NULL WHERE id = ? AND posting = 1 AND request_comment IS NULL" +
      " AND number IN (SELECT number FROM tasks WHERE state = 'blocked')"
    ).run(id);
    if (!result.changes) throw new Error('No blocked decision with unconfirmed delivery for that ID');
  }
  resumeDecision(id, number, model, log) {
    const now = new Date().toISOString();
    this.transaction(() => {
      const answer = this.db.prepare(
        'UPDATE decisions SET consumed = ?, last_error = NULL WHERE id = ? AND number = ?' +
        ' AND reply_comment IS NOT NULL AND consumed IS NULL'
      ).run(now, id, number);
      const task = this.db.prepare(
        "UPDATE tasks SET state = 'running', model = ?, log = ?, started = ?, retries = retries + 1," +
        " pid = NULL, session = NULL, completed = NULL, detail = NULL, exit_code = NULL" +
        " WHERE number = ? AND state = 'blocked'"
      ).run(model, log, now, number);
      if (!answer.changes || !task.changes) throw new Error('Decision or blocked claim is unavailable for resumption');
    });
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
