import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export function git(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  env.GIT_TERMINAL_PROMPT = '0';
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
      env, encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe']
    }).trimEnd();
  } catch (error) {
    // A remote URL, filter output, or a path can contain sensitive text.
    throw new Error('Git ' + args.slice(0, 2).filter(part => /^[a-z-]+$/.test(part)).join(' ') +
      ' failed (' + (error.code ?? error.status ?? 'unknown') + ')');
  }
}

export function inside(root, path) {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child));
}

export function verifyTarget(target, allowedRepos, stateDir) {
  if (typeof target !== 'string' || !isAbsolute(target) || !Array.isArray(allowedRepos) ||
      !allowedRepos.every(path => typeof path === 'string' && isAbsolute(path))) {
    throw new Error('Real execution requires absolute target and allowedRepos paths');
  }
  const repo = realpathSync(target);
  if (!allowedRepos.some(path => existsSync(path) && relative(realpathSync(path), repo) === '')) {
    throw new Error('Target checkout is outside allowedRepos');
  }
  const root = realpathSync(git(repo, ['rev-parse', '--show-toplevel']));
  if (relative(root, repo) !== '') throw new Error('Target must be the root of a Git checkout');
  const common = realpathSync(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (inside(repo, stateDir) || inside(stateDir, repo) ||
      inside(common, stateDir) || inside(stateDir, common)) {
    throw new Error('The state directory and target checkout must be separate');
  }
  return repo;
}

export function worktreeLocation(stateDir, number, sourceRepo = null) {
  const root = join(stateDir, 'worktrees');
  mkdirSync(root, { recursive: true });
  if (relative(realpathSync(root), root) !== '') throw new Error('Worktree directory redirects elsewhere');
  const branch = 'orchestrator/' + (sourceRepo ? 'github-issue-' : 'task-') + number;
  return { path: join(root, 'task-' + number), branch };
}

export function createWorktree(repo, location, base) {
  if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error('Worktree base must be a full commit ID');
  const refs = git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/' + location.branch]);
  if (existsSync(location.path) || refs.split(/\r?\n/).includes('refs/heads/' + location.branch)) {
    throw new Error('Task worktree or branch already exists. Inspect the existing work');
  }
  git(repo, ['worktree', 'add', '-b', location.branch, '--', location.path, base]);
}

export function removeCleanWorktree(repo, location) {
  if (relative(realpathSync(location.path), location.path) !== '' ||
      git(location.path, ['symbolic-ref', '--short', 'HEAD']) !== location.branch ||
      git(location.path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'])) {
    throw new Error('Cleanup requires a clean worktree on its recorded branch');
  }
  git(repo, ['worktree', 'remove', '--', location.path]);
}
