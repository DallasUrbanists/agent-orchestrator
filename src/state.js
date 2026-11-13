import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
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

export function hasJournal(path) {
  const journal = join(path, 'tasks.sqlite');
  if (existsSync(journal)) return true;
  if (['-wal', '-shm', '-journal'].some(suffix => existsSync(journal + suffix)) ||
      ['logs', 'worktrees', 'backups'].some(name => {
        const directory = join(path, name);
        return existsSync(directory) && readdirSync(directory).length > 0;
      })) throw new Error('The state journal is missing. Inspect the existing state and restore a verified backup');
  return false;
}

export class State {
  constructor(path, { readOnly = false } = {}) {
    hasJournal(path);
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
      "CREATE TABLE IF NOT EXISTS verified_handoffs (" +
      "  number INTEGER PRIMARY KEY REFERENCES tasks(number), repo TEXT NOT NULL, base TEXT NOT NULL," +
      "  tree TEXT NOT NULL, evidence TEXT NOT NULL, commit_sha TEXT, pull INTEGER, linked INTEGER NOT NULL DEFAULT 0, error TEXT);" +
      "CREATE TABLE IF NOT EXISTS issue_status (" +
      "  number INTEGER PRIMARY KEY REFERENCES tasks(number), pull INTEGER, error TEXT);" +
      "CREATE TABLE IF NOT EXISTS technical_recovery (" +
      "  number INTEGER PRIMARY KEY REFERENCES tasks(number), kind TEXT NOT NULL, scope TEXT NOT NULL," +
      "  used INTEGER NOT NULL DEFAULT 0, hold TEXT);" +
      "CREATE TABLE IF NOT EXISTS attempt_progress (" +
      "  attempt INTEGER PRIMARY KEY REFERENCES attempts(id), launched TEXT, activity TEXT, summary TEXT," +
      "  marker TEXT UNIQUE, actor INTEGER, comment INTEGER, posting INTEGER NOT NULL DEFAULT 0, error TEXT);" +
      "CREATE TABLE IF NOT EXISTS issue_intake_claims (" +
      "  number INTEGER PRIMARY KEY REFERENCES tasks(number), issue_id TEXT NOT NULL UNIQUE," +
      "  revision TEXT NOT NULL, coordinator_id INTEGER NOT NULL, comment_id TEXT, base TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS decisions (" +
      "  id TEXT PRIMARY KEY, number INTEGER NOT NULL, decision_key TEXT NOT NULL, template TEXT NOT NULL," +
      "  requested TEXT NOT NULL, publisher_id INTEGER, posting INTEGER NOT NULL DEFAULT 0," +
      "  request_comment INTEGER, reply_comment INTEGER, responder_id INTEGER, choice TEXT," +
      "  answered TEXT, consumed TEXT, last_error TEXT, UNIQUE(number, decision_key));" +
      "CREATE TABLE IF NOT EXISTS attempts (" +
      "  id INTEGER PRIMARY KEY AUTOINCREMENT, number INTEGER NOT NULL, worker TEXT NOT NULL," +
      "  model TEXT NOT NULL, base TEXT NOT NULL, state TEXT NOT NULL, log TEXT NOT NULL," +
      "  decision TEXT, pid INTEGER, session TEXT, started TEXT NOT NULL, completed TEXT," +
      "  detail TEXT, exit_code INTEGER);" +
      "CREATE UNIQUE INDEX IF NOT EXISTS running_attempt_per_task ON attempts(number) WHERE state = 'running';"
    );
  }
  close() { this.db.close(); }
  get(name) {
    return this.db.prepare('SELECT value FROM settings WHERE name = ?').get(name)?.value;
  }
  set(name, value) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(name, value);
  }
  assertBinding(repo, sourceRepo = null, requireAcceptance = false, coordinatorId = null) {
    const bound = this.get('repo');
    if (bound === undefined) return;
    if (bound !== repo) throw new Error('This state directory belongs to a different checkout');
    if ((this.get('sourceRepo') ?? null) !== sourceRepo) {
      throw new Error('This state directory belongs to a different task source');
    }
    const coordinator = this.get('intakeCoordinatorId');
    if (coordinator !== undefined && coordinator !== String(coordinatorId)) {
      throw new Error('This state directory uses a different GitHub intake coordinator');
    }
    if ((this.get('requireAcceptance') === 'true') !== requireAcceptance) {
      throw new Error('This state directory uses a different prerequisite policy');
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
  bind(repo, sourceRepo = null, requireAcceptance = false, coordinatorId = null) {
    this.transaction(() => {
      this.assertBinding(repo, sourceRepo, requireAcceptance, coordinatorId);
      if (this.get('repo') === undefined) {
        this.set('repo', repo);
        if (sourceRepo) this.set('sourceRepo', sourceRepo);
        if (requireAcceptance) this.set('requireAcceptance', 'true');
      }
      if (coordinatorId !== null) this.set('intakeCoordinatorId', String(coordinatorId));
    });
  }
  adoptLocalIntake(repo, sourceRepo, coordinatorId, { base, accepted }) {
    this.transaction(() => {
      this.assertBinding(repo, null, true);
      if (this.get('repo') !== repo || this.get('sourceRepo') || this.get('intakeCoordinatorId') ||
          (this.get('statusRepo') && this.get('statusRepo') !== sourceRepo)) {
        throw new Error('Expected an existing local journal for this repository');
      }
      this.set('sourceRepo', sourceRepo);
      this.set('intakeCoordinatorId', String(coordinatorId));
      this.set('intakeAcceptance', JSON.stringify({ base, accepted: [...accepted] }));
    });
  }

  list() { return this.db.prepare('SELECT * FROM tasks ORDER BY number').all(); }
  task(number) { return this.db.prepare('SELECT * FROM tasks WHERE number = ?').get(number); }

  handoffs() {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'verified_handoffs'").get()) return [];
    return this.db.prepare('SELECT number, commit_sha, pull, linked, error FROM verified_handoffs ORDER BY number').all();
  }

  handoff(number) {
    return this.db.prepare('SELECT * FROM verified_handoffs WHERE number = ?').get(number);
  }

  recordVerification(number, { repo, base, tree, evidence }) {
    this.db.prepare('INSERT INTO verified_handoffs (number, repo, base, tree, evidence) VALUES (?, ?, ?, ?, ?)')
      .run(number, repo, base, tree, evidence);
  }

  updateHandoff(number, { commit, pull, linked, error } = {}) {
    this.db.prepare('UPDATE verified_handoffs SET commit_sha = coalesce(?, commit_sha), pull = coalesce(?, pull),' +
      ' linked = coalesce(?, linked), error = ? WHERE number = ?').run(commit ?? null, pull ?? null, linked ?? null, error ?? null, number);
  }

  githubStatusRows() {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'issue_status'").get()) return [];
    return this.db.prepare('SELECT * FROM issue_status ORDER BY number').all();
  }

  updateGithubStatus(number, { error, pull } = {}) {
    this.db.prepare('INSERT INTO issue_status (number, error, pull) VALUES (?, ?, ?)' +
      ' ON CONFLICT(number) DO UPDATE SET error = excluded.error, pull = coalesce(excluded.pull, issue_status.pull)'
    ).run(number, error ?? null, pull ?? null);
  }

  observeAttempt(attempt, { launched = null, activity = null, summary = null }) {
    this.db.prepare('INSERT INTO attempt_progress (attempt, launched, activity, summary) VALUES (?, ?, ?, ?)' +
      ' ON CONFLICT(attempt) DO UPDATE SET launched = coalesce(attempt_progress.launched, excluded.launched),' +
      ' activity = coalesce(excluded.activity, attempt_progress.activity), summary = coalesce(excluded.summary, attempt_progress.summary)'
    ).run(attempt, launched, activity, summary);
  }

  githubProgress(number) {
    return this.db.prepare('SELECT attempts.*, p.launched, p.activity, p.summary, p.marker, p.actor,' +
      ' p.comment, p.posting, p.error AS publication_error FROM attempts LEFT JOIN attempt_progress p ON p.attempt = attempts.id' +
      ' WHERE number = ? ORDER BY id').all(number);
  }

  updateProgress(attempt, { marker, actor, comment, posting, error } = {}) {
    this.db.prepare(
      'INSERT INTO attempt_progress (attempt, marker, actor, comment, posting, error) VALUES (?, ?, ?, ?, ?, ?)' +
      ' ON CONFLICT(attempt) DO UPDATE SET marker = coalesce(attempt_progress.marker, excluded.marker),' +
      ' actor = coalesce(attempt_progress.actor, excluded.actor), comment = coalesce(excluded.comment, attempt_progress.comment),' +
      ' posting = coalesce(?, attempt_progress.posting), error = excluded.error'
    ).run(attempt, marker ?? null, actor ?? null, comment ?? null, posting ?? 0, error ?? null, posting ?? null);
  }

  intakeClaims() {
    if (this.get('intakeCoordinatorId') === undefined) return [];
    return this.db.prepare('SELECT * FROM issue_intake_claims ORDER BY number').all();
  }

  attempts() { return this.db.prepare('SELECT * FROM attempts ORDER BY id').all(); }

  insertAttempt(number, base, decision = null) {
    return this.db.prepare(
      "INSERT INTO attempts (number, worker, model, base, state, log, decision, started)" +
      " SELECT number, worker, model, ?, 'running', log, ?, started FROM tasks WHERE number = ?"
    ).run(base, decision, number).lastInsertRowid;
  }

  reserve({ number, repo, worker, model, location, log, base, intake }) {
    return this.transaction(() => {
      this.db.prepare(
        "INSERT INTO tasks (number, target, worker, model, state, worktree, branch, log, started)" +
        " VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)"
      ).run(number, repo, worker, model, location.path, location.branch, log, new Date().toISOString());
      if (intake) {
        this.db.prepare('INSERT INTO issue_intake_claims VALUES (?, ?, ?, ?, ?, ?)')
          .run(number, intake.issueId, intake.hash, intake.coordinatorId, intake.commentId, base);
      }
      return this.insertAttempt(number, base);
    });
  }
  process(number, attempt, { pid, threadId }) {
    this.transaction(() => {
      const update = ' SET pid = coalesce(?, pid), session = coalesce(?, session)';
      const result = this.db.prepare(
        "UPDATE attempts" + update + " WHERE id = ? AND number = ? AND state = 'running'"
      ).run(pid ?? null, threadId ?? null, attempt, number);
      if (!result.changes) throw new Error('Worker attempt no longer owns the task');
      this.db.prepare("UPDATE tasks" + update + " WHERE number = ? AND state = 'running'")
        .run(pid ?? null, threadId ?? null, number);
    });
  }
  finish(number, attempt, { state, detail, code }, decision = null, recovery = null, verification = null) {
    const completed = new Date().toISOString();
    const values = [state, detail ?? null, code ?? null, completed];
    const update = ' SET state = ?, detail = ?, exit_code = ?, completed = ?';
    this.transaction(() => {
      const result = this.db.prepare(
        "UPDATE attempts" + update + " WHERE id = ? AND number = ? AND state = 'running'"
      ).run(...values, attempt, number);
      if (!result.changes) throw new Error('Worker attempt no longer owns the task');
      this.db.prepare("UPDATE tasks" + update + " WHERE number = ? AND state = 'running'").run(...values, number);
      if (verification) this.recordVerification(number, verification);
      if (recovery) {
        this.db.prepare('INSERT INTO technical_recovery (number, kind, scope) VALUES (?, ?, ?)' +
          ' ON CONFLICT(number) DO UPDATE SET kind = excluded.kind, scope = excluded.scope, hold = NULL')
          .run(number, recovery.kind, recovery.scope);
      } else {
        this.db.prepare("UPDATE technical_recovery SET hold = 'finished' WHERE number = ?").run(number);
      }
      if (decision) {
        this.db.prepare('INSERT INTO decisions (id, number, decision_key, template, requested) VALUES (?, ?, ?, ?, ?)')
          .run(decision.id, number, decision.key, JSON.stringify(decision.template), completed);
      }
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
  answerDecision(id, { comment, author, choice }, previous = null) {
    const result = this.db.prepare(
      'UPDATE decisions SET reply_comment = ?, responder_id = ?, choice = ?, answered = ?, last_error = NULL' +
      ' WHERE id = ? AND reply_comment IS ? AND consumed IS NULL'
    ).run(comment, author, choice, new Date().toISOString(), id, previous);
    if (!result.changes) throw new Error('Decision reply changed before it could be saved');
  }
  retryDecision(id) {
    const result = this.db.prepare(
      "UPDATE decisions SET posting = 0, last_error = NULL WHERE id = ? AND posting = 1 AND request_comment IS NULL" +
      " AND number IN (SELECT number FROM tasks WHERE state = 'blocked')"
    ).run(id);
    if (!result.changes) throw new Error('No blocked decision with unconfirmed delivery for that ID');
  }
  resumeDecision(id, number, model, log, base) {
    const now = new Date().toISOString();
    return this.transaction(() => {
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
      const attempt = this.insertAttempt(number, base, id);
      return { attempt, approvedChoices: this.approvedChoices(number) };
    });
  }
  approvedChoices(number) {
    return this.db.prepare(
      'SELECT decision_key, choice, template FROM decisions WHERE number = ?' +
      ' AND consumed IS NOT NULL ORDER BY rowid'
    ).all(number);
  }
  adoptRecovery(number, kind, scope) {
    this.db.prepare(
      "INSERT OR IGNORE INTO technical_recovery (number, kind, scope) SELECT number, ?, ? FROM tasks" +
      " WHERE number = ? AND state = 'blocked' AND cleaned = 0" +
      " AND NOT EXISTS (SELECT 1 FROM decisions WHERE decisions.number = tasks.number AND consumed IS NULL)"
    ).run(kind, scope, number);
  }
  recoveryRows() {
    return this.db.prepare('SELECT * FROM technical_recovery ORDER BY number').all();
  }
  holdRecovery(number, reason) {
    this.db.prepare('UPDATE technical_recovery SET hold = ? WHERE number = ?').run(reason, number);
  }
  activeMillis(number) {
    return this.db.prepare('SELECT started, completed FROM attempts WHERE number = ? AND completed IS NOT NULL').all(number)
      .reduce((total, row) => total + Math.max(0, Date.parse(row.completed) - Date.parse(row.started)), 0);
  }
  resumeRecovery(row, model, log, base, limit) {
    const now = new Date().toISOString();
    return this.transaction(() => {
      if (row.final && (model !== 'verification-runner' || this.get('final-host-verification:' + row.number))) {
        throw new Error('Final host verification already consumed or invalid');
      }
      const budget = this.db.prepare('UPDATE technical_recovery SET used = used + 1, hold = NULL' +
        ' WHERE number = ? AND kind = ? AND scope = ? AND hold IS ? AND used < ?')
        .run(row.number, row.kind, row.scope, row.final ? 'recovery-budget-exhausted' : null, limit);
      if (row.final) this.set('final-host-verification:' + row.number, now);
      const task = this.db.prepare(
        "UPDATE tasks SET state = 'running', model = ?, log = ?, started = ?, retries = retries + 1," +
        " pid = NULL, session = NULL, completed = NULL, detail = NULL, exit_code = NULL" +
        " WHERE number = ? AND state = 'blocked'"
      ).run(model, log, now, row.number);
      if (!budget.changes || !task.changes) throw new Error('Technical recovery claim changed or exhausted');
      return this.insertAttempt(row.number, base);
    });
  }
  recover() {
    const completed = new Date().toISOString();
    this.transaction(() => {
      for (const table of ['tasks', 'attempts']) {
        this.db.prepare("UPDATE " + table + " SET state = 'interrupted', detail = 'previous-controller-exited'," +
          " completed = ? WHERE state = 'running'").run(completed);
      }
    });
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
