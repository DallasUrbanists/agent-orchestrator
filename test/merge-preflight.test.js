import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSupervisedMerge } from '../src/merge-preflight.js';
import { readMergeEvidence } from '../src/github.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const config = { repo: 'fixture/merge', head, base, reviewerId: 51,
  requiredChecks: [{ name: 'Windows tests', appId: 123 }] };
function fixture() {
  const pull = { number: 3, state: 'open', draft: false, mergeable: true, user: { id: 101 },
    head: { sha: head }, base: { sha: base, ref: 'main', repo: { full_name: config.repo } } };
  const branch = { protected: true, commit: { sha: base } };
  const check = { name: 'Windows tests', app: { id: 123 }, head_sha: head, status: 'completed', conclusion: 'success' };
  return { initial: pull, current: structuredClone(pull), main: branch, latestMain: structuredClone(branch),
    reviews: [[{ id: 1, state: 'APPROVED', commit_id: head, user: { id: 51 } }]],
    checks: [{ check_runs: [check] }], comparison: { behind_by: 0, ahead_by: 1, merge_base_commit: { sha: base } } };
}
const verify = value => checkSupervisedMerge(config, 3, {}, async () => value);

test('requires exact-head approval, a current base, and success from the configured GitHub App', async () => {
  assert.deepEqual(await verify(fixture()), {
    repo: config.repo, number: 3, head, base, eligibleAtObservation: true, protected: true, reasons: [], missingChecks: []
  });
  const stale = fixture();
  stale.current.head.sha = 'c'.repeat(40);
  stale.latestMain.commit.sha = 'd'.repeat(40);
  stale.comparison.behind_by = 1;
  stale.reviews[0].push({ ...stale.reviews[0][0], id: 2, state: 'CHANGES_REQUESTED' });
  stale.checks[0].check_runs[0].conclusion = 'failure';
  assert.deepEqual((await verify(stale)).reasons, [
    'head-base-or-pr-changed', 'head-does-not-contain-base', 'exact-head-review-missing', 'required-checks-not-passing'
  ]);
});

test('holds if a check is missing, uses a different head or app, or is ambiguous', async () => {
  for (const change of [
    rows => rows.splice(0),
    rows => { rows[0].app.id = 999; },
    rows => { rows[0].head_sha = base; },
    rows => { rows[0].status = 'in_progress'; },
    rows => rows.push({ ...rows[0] })
  ]) {
    const data = fixture();
    change(data.checks[0].check_runs);
    const result = await verify(data);
    assert.equal(result.eligibleAtObservation, false);
    assert.deepEqual(result.missingChecks, ['Windows tests']);
  }
  const staleApproval = fixture();
  staleApproval.reviews[0][0].commit_id = base;
  assert.deepEqual((await verify(staleApproval)).reasons, ['exact-head-review-missing']);
  await assert.rejects(checkSupervisedMerge({ ...config, requiredChecks: [] }, 3, {},
    () => assert.fail('empty policy reached GitHub')), /required check names/);
});

test('reads fixed GET endpoints and rereads the PR and branch after the evidence fetch', async () => {
  const paths = [];
  const run = async (command, args) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 4), ['api', '--hostname', 'github.com', '--method']);
    assert.equal(args[4], 'GET');
    paths.push(args.at(-1));
    return { stdout: '{}' };
  };
  await readMergeEvidence(config.repo, 3, head, base, {}, run);
  assert.deepEqual(paths, [
    'repos/fixture/merge/pulls/3', 'repos/fixture/merge/branches/main',
    'repos/fixture/merge/pulls/3/reviews?per_page=100',
    'repos/fixture/merge/commits/' + head + '/check-runs?filter=latest&per_page=100',
    'repos/fixture/merge/compare/' + base + '...' + head + '?per_page=1',
    'repos/fixture/merge/pulls/3', 'repos/fixture/merge/branches/main'
  ]);
});
