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

export function dependencies(body, number) {
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

async function githubRequest(method, args, failure, { signal } = {}, run = request) {
  let stdout;
  try {
    ({ stdout } = await run('gh', ['api', '--hostname', 'github.com', '--method', method, ...args], {
      encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024,
      signal, env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    }));
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error.code === 'ENOENT') throw new Error('GitHub CLI (gh) is required for GitHub issue polling');
    const sanitized = new Error(failure + '. Check gh authentication, access, and rate limits');
    sanitized.status = Number(/^gh: [^\r\n]*\(HTTP (\d{3})\)\s*$/m.exec(error.stderr ?? '')?.[1]) || undefined;
    throw sanitized;
  }
  if (method === 'DELETE' && !stdout.trim()) return null;
  try { return JSON.parse(stdout); }
  catch { throw new Error('GitHub returned unreadable ' + (failure.startsWith('GitHub issue poll') ? 'issue pages' : 'GitHub data')); }
}

export async function readGithubIssues(sourceRepo, options, run) {
  const repo = githubRepo(sourceRepo);
  const pages = await githubRequest('GET', ['--paginate', '--slurp',
    'repos/' + repo + '/issues?state=all&sort=created&direction=asc&per_page=100'],
  'GitHub issue poll failed for ' + repo, options, run);
  return normalizeIssues(pages);
}

function issueEndpoint(sourceRepo, number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid GitHub issue number');
  return 'repos/' + githubRepo(sourceRepo) + '/issues/' + number;
}

const commentsEndpoint = (sourceRepo, number) => issueEndpoint(sourceRepo, number) + '/comments';

export const githubDecisions = {
  async viewer(options, run) {
    const user = await githubRequest('GET', ['user'], 'GitHub account lookup failed', options, run);
    if (!Number.isSafeInteger(user?.id) || user.id < 1) throw new Error('GitHub did not identify the publishing account');
    return user.id;
  },
  async comments(repo, number, options, run) {
    const pages = await githubRequest('GET', ['--paginate', '--slurp', commentsEndpoint(repo, number) + '?per_page=100'],
      'GitHub issue comment lookup failed', options, run);
    if (!Array.isArray(pages) || !pages.length || !pages.every(Array.isArray)) {
      throw new Error('GitHub returned invalid issue comment pages');
    }
    return pages.flat();
  },
  post(repo, number, body, options, run) {
    return githubRequest('POST', [commentsEndpoint(repo, number), '--raw-field', 'body=' + body],
      'GitHub decision comment delivery could not be confirmed', options, run);
  }
};

export const githubStatus = {
  viewer: githubDecisions.viewer,
  comments: githubDecisions.comments,
  post(repo, number, body, options, run) {
    return githubRequest('POST', [commentsEndpoint(repo, number), '--raw-field', 'body=' + body],
      'GitHub progress comment delivery failed', options, run);
  },
  edit(repo, id, body, options, run) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid GitHub comment ID');
    return githubRequest('PATCH', ['repos/' + githubRepo(repo) + '/issues/comments/' + id,
      '--raw-field', 'body=' + body], 'GitHub progress comment update failed', options, run);
  },
  issue(repo, number, options, run) {
    return githubRequest('GET', [issueEndpoint(repo, number)], 'GitHub status issue lookup failed', options, run);
  },
  async openPulls(repo, branch, options, run) {
    repo = githubRepo(repo);
    const owner = repo.split('/')[0];
    const pages = await githubRequest('GET', ['--paginate', '--slurp',
      'repos/' + repo + '/pulls?state=open&base=main&per_page=100&head=' + encodeURIComponent(owner + ':' + branch)],
    'GitHub status pull request discovery failed', options, run);
    if (!Array.isArray(pages) || !pages.length || !pages.every(Array.isArray)) throw new Error('Invalid pull request pages');
    return pages.flat();
  },
  pull(repo, number, options, run) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid GitHub pull request number');
    return githubRequest('GET', ['repos/' + githubRepo(repo) + '/pulls/' + number],
      'GitHub status pull request lookup failed', options, run);
  },
  add(repo, number, label, options, run) {
    return githubRequest('POST', [issueEndpoint(repo, number) + '/labels', '--raw-field', 'labels[]=' + label],
      'GitHub status label add failed', options, run);
  },
  async remove(repo, number, label, options, run) {
    try {
      await githubRequest('DELETE', [issueEndpoint(repo, number) + '/labels/' + encodeURIComponent(label)],
        'GitHub status label removal failed', options, run);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
};

export async function readMergeEvidence(repo, number, head, base, options, run) {
  if (!Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(base)) {
    throw new Error('Merge evidence requires a PR number and full head and base SHAs');
  }
  const root = 'repos/' + githubRepo(repo);
  const get = (endpoint, flags = []) => githubRequest('GET', [...flags, root + '/' + endpoint],
    'GitHub merge preflight read failed', options, run);
  const pull = () => get('pulls/' + number);
  const branch = () => get('branches/main');
  const [initial, main, reviews, checks, comparison] = await Promise.all([
    pull(), branch(),
    get('pulls/' + number + '/reviews?per_page=100', ['--paginate', '--slurp']),
    get('commits/' + head + '/check-runs?filter=latest&per_page=100', ['--paginate', '--slurp']),
    get('compare/' + base + '...' + head + '?per_page=1')
  ]);
  const [current, latestMain] = await Promise.all([pull(), branch()]);
  return { initial, main, reviews, checks, comparison, current, latestMain };
}

const issueRevisionFields = `
  id number state title body createdAt lastEditedAt includesCreatedEdit
  repository { nameWithOwner }
  blockedBy(first:1) { totalCount }
  author { __typename ... on User { databaseId } }
  editor { __typename ... on User { databaseId } }
  userContentEdits(last:1) { nodes { id editedAt deletedAt } }
  timelineItems(last:1,itemTypes:[RENAMED_TITLE_EVENT]) {
    nodes { ... on RenamedTitleEvent {
      id createdAt currentTitle actor { __typename ... on User { databaseId } }
    } }
  }
`;

async function graphqlPages(query, fields, options, run) {
  const pages = await githubRequest('POST', ['graphql', '--paginate', '--slurp', '--raw-field', 'query=' + query,
    ...Object.entries(fields).flatMap(([key, value]) => ['--raw-field', key + '=' + value])],
    'GitHub intake lookup failed', options, run);
  if (!Array.isArray(pages) || !pages.length || pages.some(page => !page?.data || page.errors?.length)) {
    throw new Error('GitHub returned an incomplete intake snapshot');
  }
  return pages.map(page => page.data);
}

export const githubIntake = {
  async issues(repo, options, run) {
    const [owner, name] = githubRepo(repo).split('/');
    const pages = await graphqlPages(`query($owner:String!,$name:String!,$endCursor:String) {
      repository(owner:$owner,name:$name) {
        nameWithOwner
        issues(first:100,after:$endCursor,states:[OPEN],orderBy:{field:CREATED_AT,direction:ASC}) {
          nodes { ${issueRevisionFields} }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`, { owner, name }, options, run);
    return intakeConnections(pages.map(page => {
      if (page.repository?.nameWithOwner?.toLowerCase() !== owner + '/' + name) {
        throw new Error('GitHub returned a different intake repository');
      }
      return page.repository.issues;
    }));
  },
  async comments(id, options, run) {
    const pages = await graphqlPages(`query($id:ID!,$endCursor:String) {
      node(id:$id) {
        ... on Issue {
          ${issueRevisionFields}
          comments(first:100,after:$endCursor) {
            nodes { id body createdAt lastEditedAt includesCreatedEdit isMinimized
              author { __typename ... on User { databaseId } } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`, { id }, options, run);
    if (pages.some(page => page.node?.id !== id)) return [];
    intakeConnections(pages.map(page => page.node.comments));
    return pages.map(page => page.node);
  }
};

function intakeConnections(connections) {
  if (connections.some((page, i) => !Array.isArray(page?.nodes) ||
      page.pageInfo?.hasNextPage !== (i < connections.length - 1))) {
    throw new Error('GitHub returned incomplete intake pagination');
  }
  return connections.flatMap(page => page.nodes);
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
