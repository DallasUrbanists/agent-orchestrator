import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizedAnswer, decisionBody } from '../src/decisions.js';
import { githubDecisions } from '../src/github.js';

test('only the first exact, new, unedited reply by an authorized human wins', () => {
  const decision = { id: 'fixture-request', template: JSON.stringify({
    question: 'Continue?', choices: [{ id: 'yes', label: 'Proceed', instruction: 'Private instruction' }, { id: 'no' }]
  }) };
  const base = '2026-11-11T10:00:00Z';
  const later = '2026-11-11T10:00:01Z';
  const posted = { id: 100, created_at: base };
  const reply = (id, body, overrides = {}) => ({
    id, body, user: { id: 42, type: 'User' }, created_at: later, updated_at: later, ...overrides
  });
  const command = '/orchestrator decide fixture-request ';
  const comments = [
    reply(101, command + 'no', { user: { id: 99, type: 'User' } }),
    reply(102, command + 'no', { user: { id: 42, type: 'Bot' } }),
    reply(103, command + 'no', { updated_at: '2026-11-11T10:00:02Z' }),
    reply(99, command + 'no', { created_at: base, updated_at: base }),
    reply(104, command + 'no && unreviewed'),
    reply(105, '/orchestrator decide another-request no'),
    reply(106, command + 'unknown'),
    reply(109, command + 'no'),
    reply(108, command + 'yes')
  ];
  assert.deepEqual(authorizedAnswer(comments, posted, decision, new Set([42])), {
    comment: 108, author: 42, choice: 'yes'
  });
  assert.doesNotMatch(decisionBody(decision), /Private instruction/);
});

test('decision transport uses validated issue endpoints and passes comment text as a single argument', async () => {
  const calls = [];
  const fake = async (name, args, options) => {
    calls.push([name, args]);
    assert.equal(options.shell, undefined);
    return { stdout: JSON.stringify(args.includes('user') ? { id: 42 } :
      args.includes('--paginate') ? [[{ id: 3 }], [{ id: 4 }]] : { id: 5 }) };
  };
  assert.equal(await githubDecisions.viewer({}, fake), 42);
  assert.deepEqual(await githubDecisions.comments('Owner/Repo', 5, {}, fake), [{ id: 3 }, { id: 4 }]);
  const message = 'Reviewed text\nContains $() and ; as literal text.';
  assert.deepEqual(await githubDecisions.post('Owner/Repo', 5, message, {}, fake), { id: 5 });
  assert.deepEqual(calls, [
    ['gh', ['api', '--hostname', 'github.com', '--method', 'GET', 'user']],
    ['gh', ['api', '--hostname', 'github.com', '--method', 'GET', '--paginate', '--slurp',
      'repos/owner/repo/issues/5/comments?per_page=100']],
    ['gh', ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/owner/repo/issues/5/comments',
      '--raw-field', 'body=' + message]]
  ]);
  assert.throws(() => githubDecisions.post('Owner/Repo', '5/comments', message, {}, fake), /Invalid GitHub issue/);
});
