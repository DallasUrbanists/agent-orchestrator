import { execFile } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';

const request = promisify(execFile);
const agentStates = ['ready', 'blocked', 'in-progress', 'done'];
const models = ['terra', 'sol'];

export function githubRepo(value) {
  if (typeof value !== 'string' || value !== value.trim() ||
      !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(value) ||
      /\/\.{1,2}$/.test(value)) {
    throw new Error('GitHub repository must be in OWNER/REPO form');
  }
  return value.toLowerCase();
}

export function githubOrigin(url) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)\/?$/i.exec(url);
  if (!match) return null;
  try { return githubRepo(match[1].replace(/\.git$/i, '')); }
  catch { return null; }
}

function dependencies(body, number) {
  const lines = (body ?? '').split(/\r?\n/).filter(line => /^\s*depends on\s*:/i.test(line));
  if (lines.length === 0) return [];
  const list = lines[0].slice(lines[0].indexOf(':') + 1).trim();
  if (lines.length > 1 || !/^#[1-9]\d*(?:\s*,\s*#[1-9]\d*)*$/.test(list)) return null;
  const numbers = list.split(',').map(part => Number(part.trim().slice(1)));
  if (numbers.includes(number) || !numbers.every(Number.isSafeInteger)) return null;
  return [...new Set(numbers)];
}

function normalizeIssue(row) {
  const labels = new Set(row.labels.map(label => label.name.toLowerCase()));
  const states = agentStates.filter(state => labels.has('agent:' + state));
  const routes = models.filter(model => labels.has('model:' + model));
  const priorities = [0, 1, 2].filter(priority => labels.has('priority:p' + priority));
  const model = routes.length === 1 ? routes[0] : null;
  const issue = { number: row.number, title: row.title, state: 'blocked', model, dependencies: [],
    priority: priorities[0] ?? null };
  if (row.state === 'closed') {
    return row.state_reason === 'completed'
      ? { ...issue, state: 'done' }
      : { ...issue, reason: 'closed-without-completion' };
  }
  if (states.length !== 1) {
    return { ...issue, reason: states.length ? 'ambiguous-agent-state' : 'missing-agent-state' };
  }
  if (states[0] !== 'ready') return { ...issue, state: states[0] };
  if (!model) return { ...issue, reason: 'missing-or-ambiguous-model' };
  if (priorities.length > 1) return { ...issue, reason: 'ambiguous-priority' };
  const required = dependencies(row.body, row.number);
  if (!required) return { ...issue, reason: 'invalid-dependencies' };
  return { ...issue, state: 'ready', dependencies: required };
}

export function normalizeIssues(pages) {
  if (!Array.isArray(pages) || !pages.length || !pages.every(Array.isArray)) {
    throw new Error('GitHub returned an invalid issue page');
  }
  const seen = new Set();
  const issues = [];
  for (const row of pages.flat()) {
    if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.number) || row.number < 1 ||
        seen.has(row.number)) throw new Error('GitHub returned an invalid or duplicate issue number');
    seen.add(row.number);
    if (Object.hasOwn(row, 'pull_request')) continue;
    if (!['open', 'closed'].includes(row.state) || typeof row.title !== 'string' ||
        (row.body != null && typeof row.body !== 'string') ||
        !Array.isArray(row.labels) || !row.labels.every(label => typeof label?.name === 'string')) {
      throw new Error('GitHub returned invalid metadata for issue #' + row.number);
    }
    issues.push(normalizeIssue(row));
  }
  return issues.sort((a, b) => a.number - b.number);
}

export async function readGithubIssues(sourceRepo, { signal } = {}, run = request) {
  const repo = githubRepo(sourceRepo);
  let stdout;
  try {
    ({ stdout } = await run('gh', ['api', '--hostname', 'github.com', '--method', 'GET',
      '--paginate', '--slurp', 'repos/' + repo + '/issues?state=all&sort=created&direction=asc&per_page=100'], {
      encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024,
      signal, env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    }));
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error.code === 'ENOENT') throw new Error('GitHub CLI (gh) is required for GitHub issue polling');
    throw new Error('GitHub issue poll failed for ' + repo + '. Check gh authentication, access, and rate limits');
  }
  let pages;
  try { pages = JSON.parse(stdout); }
  catch { throw new Error('GitHub returned unreadable issue pages'); }
  return normalizeIssues(pages);
}

export function validatePolling(polls, intervalMs) {
  if (!Number.isSafeInteger(polls) || polls < 1 || polls > 1000 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60000) {
    throw new Error('Specify 1 to 1000 polls and a polling interval up to 60 seconds');
  }
}

export async function* pollGithubIssues(repo, { polls = 1, intervalMs = 15000, signal } = {}) {
  const sourceRepo = githubRepo(repo);
  validatePolling(polls, intervalMs);
  for (let index = 0; index < polls && !signal?.aborted; index++) {
    if (index) await wait(intervalMs, undefined, { signal });
    const issues = await readGithubIssues(sourceRepo, { signal });
    yield { sourceRepo, observedAt: new Date().toISOString(), issues };
  }
}
