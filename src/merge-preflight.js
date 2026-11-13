import { githubRepo, readMergeEvidence } from './github.js';

const positive = value => Number.isSafeInteger(value) && value > 0;
const fullSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const reviewStates = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

export async function checkSupervisedMerge(config, number, options, read = readMergeEvidence) {
  const repo = githubRepo(config?.repo);
  const { head, base, reviewerId, requiredChecks } = config;
  if (!positive(number) || !fullSha(head) || !fullSha(base) || head === base || !positive(reviewerId) ||
      !Array.isArray(requiredChecks) || !requiredChecks.length ||
      requiredChecks.some(check => typeof check?.name !== 'string' || !check.name.trim() || !positive(check.appId)) ||
      new Set(requiredChecks.map(check => check.name)).size !== requiredChecks.length) {
    throw new Error('Provide a PR number, distinct full head and base SHAs, a numeric reviewer ID, and required check names with app IDs');
  }

  const { initial, main, reviews, checks, comparison, current, latestMain } = await read(repo, number, head, base, options);
  const matches = pull => pull?.number === number && pull.state === 'open' && pull.draft === false &&
    pull.head?.sha === head && pull.base?.sha === base && pull.base.ref === 'main' &&
    pull.base.repo?.full_name?.toLowerCase() === repo;
  const reasons = [];
  if (!matches(initial) || !matches(current) || main?.commit?.sha !== base || latestMain?.commit?.sha !== base) {
    reasons.push('head-base-or-pr-changed');
  }
  if (initial?.mergeable !== true || current?.mergeable !== true) reasons.push('mergeability-not-confirmed');
  if (comparison?.merge_base_commit?.sha !== base || comparison.behind_by !== 0 ||
      !positive(comparison.ahead_by)) reasons.push('head-does-not-contain-base');

  if (!Array.isArray(reviews) || !reviews.length || !reviews.every(Array.isArray) ||
      !Array.isArray(checks) || !checks.length || checks.some(page => !Array.isArray(page?.check_runs))) {
    throw new Error('GitHub returned incomplete review or check evidence');
  }
  const review = reviews.flat().filter(row => row?.user?.id === reviewerId && reviewStates.has(row.state))
    .sort((a, b) => b.id - a.id)[0];
  if (!positive(review?.id) || review.state !== 'APPROVED' || review.commit_id !== head ||
      initial?.user?.id === reviewerId || current?.user?.id === reviewerId) reasons.push('exact-head-review-missing');

  const byName = new Map();
  for (const check of checks.flatMap(page => page.check_runs)) {
    if (typeof check?.name !== 'string') throw new Error('GitHub returned invalid check evidence');
    const rows = byName.get(check.name) ?? [];
    rows.push(check);
    byName.set(check.name, rows);
  }
  const missingChecks = requiredChecks.filter(expected => {
    const rows = byName.get(expected.name);
    return rows?.length !== 1 || rows[0].head_sha !== head || rows[0].app?.id !== expected.appId ||
      rows[0].status !== 'completed' || rows[0].conclusion !== 'success';
  }).map(check => check.name);
  if (missingChecks.length) reasons.push('required-checks-not-passing');

  return { repo, number, head, base, eligibleAtObservation: reasons.length === 0,
    protected: main?.protected === true && latestMain?.protected === true, reasons, missingChecks };
}
