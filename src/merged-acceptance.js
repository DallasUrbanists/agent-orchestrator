import { execFileSync } from 'node:child_process';
import { git } from './worktrees.js';

const sha = /^[a-f0-9]{40}$/;

function readPull(repo, pull) {
  return JSON.parse(execFileSync('gh', ['api', 'repos/' + repo + '/pulls/' + pull], {
    encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  }));
}

export function acceptedMerge({ target, repo, base, pull, head, branch, coordinatorId, read = readPull }) {
  if (!Number.isSafeInteger(pull) || pull < 1 || !sha.test(head) || !sha.test(base)) return null;
  const result = read(repo, pull);
  const merged = result.merge_commit_sha;
  if (result.number !== pull || !result.merged || result.merged_by?.id !== coordinatorId ||
      result.head?.sha !== head || result.head?.ref !== branch || result.base?.ref !== 'main' ||
      result.head?.repo?.full_name?.toLowerCase() !== repo || result.base?.repo?.full_name?.toLowerCase() !== repo ||
      !sha.test(merged)) return null;
  git(target, ['merge-base', '--is-ancestor', merged, base]);
  // Only accept when the integration tree exactly matches the tree that passed verification.
  return git(target, ['rev-parse', merged + '^{tree}']) === git(target, ['rev-parse', head + '^{tree}'])
    ? merged : null;
}
