import assert from 'node:assert/strict';
import test from 'node:test';
import { githubOrigin, githubRepo, normalizeIssues, readGithubIssues } from '../src/github.js';

const ready = (number, overrides = {}) => ({
  number, state: 'open', title: 'Issue ' + number, body: null,
  labels: [{ name: 'agent:ready' }, { name: 'model:terra' }], ...overrides
});

test('normalizes issue metadata across pages and excludes pull requests and raw bodies', () => {
  const pages = [[ready(1, { state: 'closed', state_reason: 'completed' })], [
    ready(2, { body: 'Untrusted body\nDepends on: #1', labels: [
      { name: 'Agent:Ready' }, { name: 'model:sol' }, { name: 'priority:p1' }
    ] }),
    ready(3, { pull_request: {} }),
    ready(4, { state: 'closed', state_reason: 'not_planned' })
  ]];
  const rows = normalizeIssues(pages);
  assert.deepEqual(rows.map(row => [row.number, row.state]), [[1, 'done'], [2, 'ready'], [4, 'blocked']]);
  assert.deepEqual(rows[1], {
    number: 2, state: 'ready', title: 'Issue 2', model: 'sol', priority: 1, dependencies: [1]
  });
  assert.doesNotMatch(JSON.stringify(rows), /Untrusted body/);
});

test('ambiguous labels and malformed dependencies block only the affected issues', () => {
  const rows = normalizeIssues([[
    ready(1, { labels: [{ name: 'agent:ready' }, { name: 'agent:blocked' }, { name: 'model:sol' }] }),
    ready(2, { labels: [{ name: 'agent:ready' }, { name: 'model:terra' }, { name: 'model:sol' }] }),
    ready(3, { body: 'Depends on: other/repo#7' }),
    ready(4, { body: 'Depends on: #4' }),
    ready(5, { body: 'Depends on: #1\nDepends on: #2' }),
    ready(6)
  ]]);
  assert.deepEqual(rows.map(row => row.reason ?? row.state), [
    'ambiguous-agent-state', 'missing-or-ambiguous-model', 'invalid-dependencies',
    'invalid-dependencies', 'invalid-dependencies', 'ready'
  ]);
});

test('rejects malformed and duplicate issue pages before any work can be scheduled', () => {
  assert.throws(() => normalizeIssues({ items: [] }), /invalid issue page/);
  assert.throws(() => normalizeIssues([[ready(1)], [ready(1)]]), /duplicate issue number/);
  assert.throws(() => normalizeIssues([[ready(2, { labels: [null] })]]), /invalid metadata/);
});

test('uses a fixed GET-only gh request with pagination and repository validation', async () => {
  const rows = await readGithubIssues('Owner/Project', {}, async (executable, args, options) => {
    assert.equal(executable, 'gh');
    assert.deepEqual(args, ['api', '--hostname', 'github.com', '--method', 'GET', '--paginate', '--slurp',
      'repos/owner/project/issues?state=all&sort=created&direction=asc&per_page=100']);
    assert.equal(options.shell, undefined);
    assert.equal(options.env.GH_PROMPT_DISABLED, '1');
    assert.ok(options.timeout > 0);
    return { stdout: JSON.stringify([[ready(4)], [ready(7)]]) };
  });
  assert.deepEqual(rows.map(row => row.number), [4, 7]);
  for (const input of ['https://github.com/a/b', 'a/..', 'a/b\n', 'a/b?x=y', 'a/b/c']) {
    assert.throws(() => githubRepo(input), /OWNER\/REPO/);
  }
  assert.equal(githubOrigin('git@github.com:Owner/Project.git'), 'owner/project');
  assert.equal(githubOrigin('ssh://git@github.com/Owner/Project.git'), 'owner/project');
  assert.equal(githubOrigin('https://github.com/Owner/Project.git'), 'owner/project');
  assert.equal(githubOrigin('https://elsewhere.example/Owner/Project.git'), null);
});

test('marks transient transport failures without exposing the captured diagnostic', async () => {
  for (const [stderr, transient] of [
    ['gh: Service unavailable (HTTP 503)', true],
    ['gh: Get API: connection reset by peer', true],
    ['gh: API rate limit exceeded (HTTP 403)', false],
    ['gh: Unauthorized (HTTP 401)', false]
  ]) {
    await assert.rejects(readGithubIssues('owner/project', {}, async () => {
      throw Object.assign(new Error('sensitive details'), { code: 1, stderr });
    }), error => error.transient === transient && !error.message.includes(stderr));
  }
});

test('failed or invalid GitHub reads never expose captured output or accept a partial snapshot', async () => {
  await assert.rejects(readGithubIssues('owner/project', {}, async () => {
    throw Object.assign(new Error('secret command output'), {
      code: 1, stdout: JSON.stringify([[ready(1)]]), stderr: 'secret diagnostic'
    });
  }), /^Error: GitHub issue poll failed for owner\/project\./);
  await assert.rejects(readGithubIssues('owner/project', {}, async () => ({ stdout: 'partial { output' })),
    /unreadable issue pages/);
});
