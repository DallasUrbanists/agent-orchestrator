import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { execute, preview } from '../src/controller.js';
import { findCodex, runCodex } from '../src/codex.js';
import { githubIntake } from '../src/github.js';
import { readIssueIntake } from '../src/intake.js';
import { State } from '../src/state.js';
import { git } from '../src/worktrees.js';

const coordinatorId = 24529106;
const repoName = 'fixture/intake';
const user = id => ({ __typename: 'User', databaseId: id });
const time = seconds => '2026-01-01T00:00:' + String(seconds).padStart(2, '0') + 'Z';
const approval = (id, author, seconds, body = '/orchestrator approve') => ({
  id, author: user(author), body, createdAt: time(seconds),
  lastEditedAt: null, includesCreatedEdit: false, isMinimized: false
});
const issue = (number, author, body) => ({
  number, id: 'issue-' + number, title: 'Fixture task ' + number, body, author: user(author),
  state: 'OPEN', createdAt: time(0), lastEditedAt: null, includesCreatedEdit: false, editor: null,
  userContentEdits: { nodes: [] }, timelineItems: { nodes: [] },
  repository: { nameWithOwner: repoName }, blockedBy: { totalCount: 0 }
});
const connection = (nodes, hasNextPage = false) => ({ nodes, pageInfo: { hasNextPage } });
const edit = (row, seconds, editor, body) => ({
  ...row, body, editor: user(editor), lastEditedAt: time(seconds),
  userContentEdits: { nodes: [{ id: 'edit-' + seconds, editedAt: time(seconds), deletedAt: null }] }
});

function fixtureApi(rows, comments, { detail = row => row, beforePoll = () => {} } = {}) {
  const requests = [];
  const run = async (command, args) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 8), ['api', '--hostname', 'github.com', '--method', 'POST',
      'graphql', '--paginate', '--slurp']);
    const query = args.find(arg => arg.startsWith('query='));
    assert.ok(query.startsWith('query=query('));
    assert.equal(query.includes('mutation'), false);
    const nodeId = args.find(arg => arg.startsWith('id='))?.slice(3);
    requests.push(nodeId ?? 'issues');
    if (nodeId === undefined) {
      beforePoll();
      assert.ok(args.includes('owner=fixture') && args.includes('name=intake'));
      const all = rows();
      const batches = all.length > 1 ? [all.slice(0, 1), all.slice(1)] : [all];
      return { stdout: JSON.stringify(batches.map((nodes, index) => ({ data: {
        repository: { nameWithOwner: repoName, issues: connection(nodes, index === 0 && batches.length > 1) }
      } }))) };
    }
    const row = detail(rows().find(candidate => candidate.id === nodeId));
    const all = comments.get(nodeId) ?? [];
    const batches = all.length > 1 ? [all.slice(0, 1), all.slice(1)] : [all];
    return { stdout: JSON.stringify(batches.map((nodes, index) => ({ data: {
      node: { ...row, comments: connection(nodes, index === 0 && batches.length > 1) }
    } }))) };
  };
  return { requests, issues: (repo, options) => githubIntake.issues(repo, options, run),
    comments: (id, options) => githubIntake.comments(id, options, run) };
}

test('intake resumes the same approved claim after an authorized decision reply', async t => {
  const root = mkdtempSync(join(tmpdir(), 'intake-decisions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'target');
  const remote = join(root, 'origin.git');
  const stateDir = join(root, 'run');
  git(root, ['init', '--initial-branch=main', repo]);
  git(root, ['init', '--bare', '--initial-branch=main', remote]);
  git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Seed fixture']);
  git(remote, ['fetch', '--', repo, 'refs/heads/main:refs/heads/main']);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/' + repoName]);
  git(repo, ['config', '--local', 'url.' + pathToFileURL(remote).href + '.insteadOf', 'https://github.com/' + repoName]);
  const original = issue(1, coordinatorId, 'Work needing a decision');
  const edited = issue(2, coordinatorId, 'Another task needing a decision');
  let rows = [original, edited, issue(3, coordinatorId, 'Independent task')];
  const intakeApi = fixtureApi(() => rows, new Map());
  const queue = { target: repo, allowedRepos: [repo], sourceRepo: repoName, githubIntake: { coordinatorId },
    acceptedPrerequisites: [], authorizedResponders: [coordinatorId] };
  const { revisions } = await preview(queue, stateDir, { intakeApi });
  const template = { key: 'layout', question: 'Which layout should we use?',
    choices: [{ id: 'grid', label: 'Grid', instruction: 'Use the reviewed grid.' },
      { id: 'list', label: 'List', instruction: 'Use the reviewed list.' }] };
  queue.intakeDecisions = revisions.slice(0, 2).map(revision => ({ ...revision, decisions: [template] }));
  const comments = new Map();
  const decisionApi = {
    async viewer() { return coordinatorId; },
    async comments(_repo, number) { return comments.get(number) ?? []; },
    async post(_repo, number, body) {
      assert.equal(comments.has(number), false, 'duplicate decision question');
      const posted = { id: 10, user: { id: coordinatorId }, body, created_at: time(1) };
      comments.set(number, [posted]);
      return posted;
    }
  };
  const opts = { decisionsEnabled: true, decisionApi, intakeApi, limit: 3, polls: 2, intervalMs: 5,
    readAcceptance: () => [] };
  const started = await execute(queue, stateDir, opts, async ({ cwd, prompt }) => {
    if (prompt.includes('Independent task')) {
      assert.doesNotMatch(prompt, /Which layout/);
      return { state: 'done' };
    }
    assert.match(prompt, /Which layout/);
    writeFileSync(join(cwd, 'prior.txt'), 'saved work');
    return { state: 'blocked', result: { decisionKey: 'layout' } };
  });
  assert.deepEqual(started.results.map(row => [row.number, row.state]), [[1, 'blocked'], [2, 'blocked'], [3, 'done']]);
  for (const { number, decision } of started.results.slice(0, 2)) {
    const reply = (id, author) => ({ id, user: { id: author, type: 'User' },
      body: '/orchestrator decide ' + decision + ' grid', created_at: time(2), updated_at: time(2) });
    comments.get(number).push(reply(11, 99), reply(12, coordinatorId), reply(13, coordinatorId));
  }
  rows = [original, edit(edited, 1, coordinatorId, 'Different task'), rows[2]];
  const resumed = await execute(queue, stateDir, opts, async ({ cwd, prompt }) => {
    assert.match(prompt, /Use the reviewed grid/);
    assert.match(prompt, /Work needing a decision/);
    assert.equal(readFileSync(join(cwd, 'prior.txt'), 'utf8'), 'saved work');
    return { state: 'done' };
  });
  assert.deepEqual(resumed.results.map(row => [row.number, row.state]), [[1, 'done']]);
  const final = new State(stateDir, { readOnly: true });
  try {
    assert.equal(final.intakeClaims().length, 3);
    assert.equal(final.decisionStatus().find(row => row.number === 1).reply_comment, 12);
    assert.equal(final.decisionStatus().find(row => row.number === 2).last_error, 'intake-decision-scope-no-longer-approved');
    assert.equal(final.task(2).state, 'blocked');
  } finally { final.close(); }
  assert.deepEqual((await execute(queue, stateDir, opts, () => assert.fail('duplicate dispatch'))).results, []);
});

test('only the exact unedited command from the numeric coordinator approves the current issue revision', async () => {
  const author = issue(1, coordinatorId, 'A scoped task');
  const other = issue(2, 111, 'Another scoped task');
  let rows = [author, other];
  let detail = row => row;
  const comments = new Map([[other.id, [
    approval('wrong-account', 222, 1),
    approval('not-exact', coordinatorId, 2, '/orchestrator approve\n'),
    { ...approval('edited-comment', coordinatorId, 3), lastEditedAt: time(4) },
    { ...approval('minimized', coordinatorId, 4), isMinimized: true }
  ]]]);
  const api = fixtureApi(() => rows, comments, { detail: row => detail(row) });
  const load = () => readIssueIntake(repoName, coordinatorId, {}, api);
  assert.deepEqual((await load()).map(row => row.state), ['ready', 'blocked']);
  assert.deepEqual(api.requests, ['issues', other.id]);
  comments.get(other.id).push(approval('approved-original', coordinatorId, 5));
  const original = (await load())[1];
  assert.equal(original.intake.commentId, 'approved-original');
  assert.equal(original.prompt, other.title + '\n\n' + other.body);
  detail = row => edit(row, 6, 111, 'Edit during comment lookup');
  assert.equal((await load())[1].reason, 'needs-coordinator-approval');
  detail = row => row;
  // Reverting to the same text still requires fresh approval.
  const reverted = edit(other, 6, 111, other.body);
  rows = [author, reverted];
  comments.get(other.id).push(approval('same-second', coordinatorId, 6));
  assert.equal((await load())[1].reason, 'needs-coordinator-approval');
  comments.get(other.id).push(approval('approved-revision', coordinatorId, 7));
  const revised = (await load())[1];
  assert.equal(revised.intake.commentId, 'approved-revision');
  assert.notEqual(revised.intake.hash, original.intake.hash);
  const rename = row => ({ ...row, title: 'Renamed', timelineItems: { nodes: [
    { id: 'rename', createdAt: time(8), actor: user(111), currentTitle: 'Renamed' }
  ] } });
  rows = [rename(author), rename(reverted)];
  assert.deepEqual((await load()).map(row => row.reason), ['needs-coordinator-approval', 'needs-coordinator-approval']);
  comments.set(author.id, [approval('approve-external-edit', coordinatorId, 9)]);
  assert.equal((await load())[0].state, 'ready');
});

test('requires complete GitHub GraphQL pagination', async () => {
  const run = async () => ({ stdout: JSON.stringify([{ data: { repository: {
    nameWithOwner: repoName, issues: connection([], true)
  } } }]) });
  await assert.rejects(githubIntake.issues(repoName, {}, run), /incomplete intake pagination/);
});

test('parses the existing Storytelling Studio routing format and holds unsupported gates', async () => {
  const body = [
    '**Preferred model:** GPT-6.1 Terra. **Reasoning:** high. **Target:** 45 minutes.',
    '**Dependencies:** D1-02, D1-05.',
    '### Linked prerequisites',
    '- [D1-02](https://github.com/fixture/intake/issues/2)',
    '- [D1-05](https://github.com/fixture/intake/issues/5)',
    '### Controller dispatch metadata',
    '| ID | requiresAll | requiresAny | stream | model | reasoning | priority | leases | condition |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| D1-06 | D1-02,D1-05 | - | editor | terra | high | 10 | - | baseline |'
  ].join('\r\n');
  const otherOrigin = body.replace('/fixture/intake/issues/5', '/fixture/other/issues/5');
  const api = fixtureApi(() => [
    issue(6, coordinatorId, body),
    issue(7, coordinatorId, otherOrigin),
    issue(8, coordinatorId, body.replace('| baseline |', '| conditional |')),
    { ...issue(9, coordinatorId, 'Generic task'), blockedBy: { totalCount: 1 } }
  ], new Map());
  const [ready, ...held] = await readIssueIntake(repoName, coordinatorId, {}, api);
  assert.deepEqual([ready.model, ready.reasoning, ready.priority, ready.dependencies], ['terra', 'high', 10, [2, 5]]);
  assert.ok(held.every(row => row.reason === 'unsupported-task-metadata-or-revision'));
});

test('one controller discovers, approves, waits for supervised acceptance, and dispatches from fetched main', {
  timeout: 275000
}, async t => {
  const live = process.env.ORCHESTRATOR_LIVE_INTAKE === '1';
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-intake-'));
  if (live) t.diagnostic('Retained disposable workspace: ' + root);
  else t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'target'), remote = join(root, 'origin.git'), supervisor = join(root, 'supervisor');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(root, ['init', '--bare', '--initial-branch=main', remote]);
  writeFileSync(join(repo, 'first.txt'), 'seed\n');
  writeFileSync(join(repo, 'second.txt'), 'seed\n');
  const identity = ['-c', 'user.name=Supervisor', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
  git(repo, ['add', '.']);
  git(repo, [...identity, 'commit', '-m', 'Seed fixture']);
  git(remote, ['fetch', '--', repo, 'refs/heads/main:refs/heads/main']);
  git(root, ['clone', '--', remote, supervisor]);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/intake.git']);
  git(repo, ['config', '--local', 'url.' + pathToFileURL(remote).href + '.insteadOf', 'https://github.com/fixture/intake.git']);
  const seed = git(repo, ['rev-parse', 'HEAD']);
  const stateDir = join(root, 'run');
  const receipts = join(root, 'acceptance.json');
  writeFileSync(receipts, '[]');
  const queue = { target: repo, allowedRepos: [repo], sourceRepo: repoName, githubIntake: { coordinatorId },
    acceptedPrerequisites: [] };
  const first = issue(1, coordinatorId, 'Set first.txt to exactly first-accepted and report done. Leave other files alone.');
  const second = issue(2, 111, 'Depends on: #1\nSet second.txt to outdated and report done.');
  let rows = [first];
  const comments = new Map();
  const claim = number => {
    const state = new State(stateDir, { readOnly: true });
    try { return state.task(number); } finally { state.close(); }
  };
  let poll = 0;
  let merged;
  const api = fixtureApi(() => rows, comments, { beforePoll() {
    switch (++poll) {
      case 2:
        assert.equal(claim(1).state, 'done');
        rows = [first, second];
        break;
      case 3:
        assert.equal(claim(2), undefined, 'unapproved issue claimed');
        comments.set(second.id, [approval('wrong-account', 222, 1)]);
        break;
      case 4:
        assert.equal(claim(2), undefined, 'wrong account approved issue');
        comments.get(second.id).push(approval('original', coordinatorId, 2));
        break;
      case 5:
        assert.equal(claim(2), undefined, 'approval bypassed prerequisites');
        rows = [first, edit(second, 3, 111, 'Depends on: #1\nRead first.txt. If it contains first-accepted, set second.txt to exactly saw-first-accepted and report done. Leave other files alone.')];
        git(claim(1).worktree, ['add', 'first.txt']);
        git(claim(1).worktree, [...identity, 'commit', '-m', 'Accept issue one']);
        git(supervisor, ['fetch', repo, claim(1).branch]);
        git(supervisor, [...identity, 'merge', '--no-ff', '--no-edit', 'FETCH_HEAD']);
        git(remote, ['fetch', '--', supervisor, 'refs/heads/main:refs/heads/main']);
        merged = git(supervisor, ['rev-parse', 'HEAD']);
        break;
      case 6:
        assert.equal(claim(2), undefined, 'merge bypassed acceptance');
        writeFileSync(receipts + '.next', JSON.stringify([{ number: 1, commit: merged }]));
        renameSync(receipts + '.next', receipts);
        break;
      case 7:
        assert.equal(claim(2), undefined, 'edited issue dispatched before acceptance');
        break;
      case 8:
        assert.equal(claim(2), undefined, 'stale approval survived the edit');
        comments.get(second.id).push(approval('reapproved', coordinatorId, 4));
        break;
    }
  } });
  const launched = [];
  const options = { executable: live ? findCodex() : 'fixture', limit: 2, polls: 12, intervalMs: 5, timeoutMs: 100000,
    intakeApi: api, acceptancePath: receipts, readAcceptance: () => JSON.parse(readFileSync(receipts, 'utf8')) };
  const result = await execute(queue, stateDir, options, async worker => {
    launched.push(worker.prompt);
    if (live) return runCodex(worker);
    if (launched.length === 1) writeFileSync(join(worker.cwd, 'first.txt'), 'first-accepted\n');
    else {
      assert.equal(readFileSync(join(worker.cwd, 'first.txt'), 'utf8').trim(), 'first-accepted');
      writeFileSync(join(worker.cwd, 'second.txt'), 'saw-first-accepted\n');
    }
    return { state: 'done' };
  });
  assert.deepEqual(result.results.map(row => [row.number, row.state]), [[1, 'done'], [2, 'done']]);
  assert.match(launched[1], /saw-first-accepted/);
  assert.equal(readFileSync(join(claim(2).worktree, 'second.txt'), 'utf8').trim(), 'saw-first-accepted');
  assert.equal(git(repo, ['rev-parse', 'HEAD']), seed, 'controller rewrote the local checkout');
  assert.equal(git(claim(1).worktree, ['rev-parse', 'HEAD^']), seed);
  assert.equal(git(claim(2).worktree, ['rev-parse', 'HEAD']), merged);
  const state = new State(stateDir, { readOnly: true });
  try {
    assert.deepEqual(state.intakeClaims().map(row => [row.issue_id, row.coordinator_id, row.comment_id, row.base]),
      [[first.id, coordinatorId, null, seed], [second.id, coordinatorId, 'reapproved', merged]]);
    assert.deepEqual(state.attempts().map(row => [row.number, row.state, row.base]),
      [[1, 'done', seed], [2, 'done', merged]]);
  } finally { state.close(); }

  rows = [first, edit(rows[1], 5, 111, 'Depends on: #1\nEdited again after dispatch.')];
  comments.get(second.id).push(approval('after-dispatch', coordinatorId, 6));
  const restarted = await execute(queue, stateDir, { ...options, polls: 1 }, () => assert.fail('duplicate launch'));
  assert.deepEqual(restarted, { reason: 'no-eligible-work', results: [] });
  await assert.rejects(execute({ ...queue, githubIntake: { coordinatorId: 222 } }, stateDir, options),
    /different GitHub intake coordinator/);
  await assert.rejects(execute(queue, stateDir, { ...options, readAcceptance: () => [] },
    () => assert.fail('dispatch after losing a receipt')), /Acceptance receipt changed or disappeared for #1/);
  const previewResult = await preview(queue, stateDir, { intakeApi: api });
  assert.deepEqual(previewResult.eligible, []);
  t.diagnostic(JSON.stringify({ liveCodex: live, controllerPid: process.pid, seed, merge: merged, dependentBase: merged }));
});
