import { createHash } from 'node:crypto';
import { dependencies, githubIntake } from './github.js';

const approve = '/orchestrator approve';
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const userId = actor => actor?.__typename === 'User' && positiveId(actor.databaseId) ? actor.databaseId : null;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)
  ? Date.parse(value) : NaN;

function revision(issue) {
  const created = timestamp(issue.createdAt);
  const edit = issue.userContentEdits?.nodes;
  const rename = issue.timelineItems?.nodes;
  if (!Array.isArray(edit) || edit.length > 1 || !Array.isArray(rename) || rename.length > 1 ||
      !Number.isFinite(created) || typeof issue.title !== 'string' || typeof issue.body !== 'string' ||
      typeof issue.includesCreatedEdit !== 'boolean' || !Number.isSafeInteger(issue.blockedBy?.totalCount) ||
      issue.blockedBy.totalCount < 0) return null;
  const edited = issue.lastEditedAt === null ? created : timestamp(issue.lastEditedAt);
  const renamed = rename.length ? timestamp(rename[0]?.createdAt) : created;
  if (!(edited >= created && renamed >= created) ||
      (edit.length && (!edit[0]?.id || edit[0].deletedAt !== null || timestamp(edit[0].editedAt) !== edited)) ||
      (issue.lastEditedAt !== null && !edit.length) || (issue.includesCreatedEdit && !edit.length) ||
      (rename.length && (!rename[0]?.id || rename[0].currentTitle !== issue.title))) return null;
  const author = userId(issue.author);
  const editor = issue.lastEditedAt === null ? author : userId(issue.editor);
  const titleEditor = rename.length ? userId(rename[0].actor) : author;
  return {
    after: Math.max(created, edited, renamed),
    author, editor, titleEditor,
    hash: createHash('sha256').update(JSON.stringify([
      issue.id, issue.number, issue.title, issue.body, issue.createdAt, issue.lastEditedAt, edit[0]?.id,
      rename[0]?.id, rename[0]?.createdAt, author, editor, titleEditor, issue.blockedBy.totalCount
    ])).digest('hex')
  };
}

function routeIssue(issue, repo) {
  // The first release supports approved body declarations. Native blockers are held
  // because GitHub edits them independently of the body approval.
  if (issue.blockedBy.totalCount) return null;
  const { body, number } = issue;
  const numeric = dependencies(body, number);
  if (!numeric) return null;
  const lines = body.split(/\r?\n/);
  const metadata = lines.findIndex(line => /^### Controller dispatch metadata\s*$/i.test(line));
  const declared = lines.filter(line => /^\s*\*\*Dependencies:\*\*/i.test(line));
  if (lines.some(line => /^\s*(?:\*\*)?(?:depends on|dependencies)\*{0,2}\s*:/i.test(line) &&
      !/^\s*(?:depends on\s*:|\*\*Dependencies:\*\*)/i.test(line))) return null;
  const preferred = lines.filter(line => /^\s*\*\*Preferred model:\*\*/i.test(line));
  if (metadata === -1 && !declared.length && !preferred.length) {
    return { dependencies: numeric, model: 'terra', reasoning: 'medium' };
  }
  if (metadata === -1 || declared.length !== 1 || preferred.length !== 1 || numeric.length) return null;
  const table = lines.slice(metadata + 1);
  const header = table.findIndex(line => /^\s*\| ID \| requiresAll \| requiresAny \| stream \| model \| reasoning \| priority \| leases \| condition \|\s*$/.test(line));
  if (header === -1 || !/^\s*\|(?:\s*---\s*\|){9}\s*$/.test(table[header + 1] ?? '')) return null;
  const row = table[header + 2]?.trim().split('|').slice(1, -1).map(value => value.trim());
  if (row?.length !== 9 || /^\s*\|/.test(table[header + 3] ?? '')) return null;
  const [task, all, any, , model, reasoning, priority, leases, condition] = row;
  const route = preferred[0].match(/^\s*\*\*Preferred model:\*\* GPT-6\.1 (Terra|Sol)\. \*\*Reasoning:\*\* (medium|high)\./);
  if (!/^[A-Z]\d+-\d+$/.test(task) || any !== '-' || condition !== 'baseline' ||
      route?.[1].toLowerCase() !== model || route?.[2] !== reasoning ||
      (model === 'sol' && reasoning !== 'high') || !/^\d{1,4}$/.test(priority) ||
      !/^(?:-|[a-z0-9-]+(?:,[a-z0-9-]+)*)$/.test(leases)) return null;
  const required = all === '-' ? [] : all.split(',');
  const human = declared[0].replace(/^\s*\*\*Dependencies:\*\*\s*/i, '').replace(/\.$/, '').split(/,\s*/);
  if (required.join(',') !== human.join(',') && !(all === '-' && /^(none|-)?$/i.test(human[0]))) return null;
  const links = new Map();
  const section = body.split(/^### Linked prerequisites[ \t]*\r?$/m)[1]?.split(/^### /m)[0] ?? '';
  for (const line of section.split(/\r?\n/)) {
    const link = line.match(/^\s*-\s+\[([A-Z]\d+-\d+)\]\(https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)\)\s*$/i);
    if (!link) continue;
    const [, key, target, id] = link;
    if (target.toLowerCase() !== repo || !positiveId(Number(id)) || Number(id) === number || links.has(key)) return null;
    links.set(key, Number(id));
  }
  if (required.some(key => !links.has(key)) || new Set(required).size !== required.length) return null;
  return { model, reasoning, priority: Number(priority), dependencies: required.map(key => links.get(key)) };
}

export async function readIssueIntake(repo, coordinatorId, options, api = githubIntake) {
  if (!positiveId(coordinatorId)) throw new Error('GitHub intake requires a positive numeric coordinatorId');
  const rows = await api.issues(repo, options);
  const seen = new Set(), ids = new Set();
  const issues = [];
  for (const issue of rows) {
    if (!positiveId(issue?.number) || typeof issue.id !== 'string' || !issue.id || issue.state !== 'OPEN' ||
        seen.has(issue.number) || ids.has(issue.id)) throw new Error('GitHub returned invalid or duplicate intake issues');
    seen.add(issue.number);
    ids.add(issue.id);
    const held = { number: issue.number, title: issue.title, state: 'blocked' };
    if (issue.repository?.nameWithOwner?.toLowerCase() !== repo) throw new Error('GitHub returned a different issue repository');
    const current = revision(issue);
    const route = current && routeIssue(issue, repo);
    if (!route || !issue.body.trim() || issue.body.length + issue.title.length > 31800) {
      issues.push({ ...held, reason: 'unsupported-task-metadata-or-revision' });
      continue;
    }
    let comment;
    if (current.author !== coordinatorId || current.editor !== coordinatorId || current.titleEditor !== coordinatorId) {
      const pages = await api.comments(issue.id, options);
      if (pages.length && pages.every(page => page.state === 'OPEN' &&
          page.repository?.nameWithOwner?.toLowerCase() === repo && revision(page)?.hash === current.hash)) {
        comment = pages.flatMap(page => page.comments.nodes).find(item => item?.body === approve &&
          userId(item.author) === coordinatorId && item.lastEditedAt === null && item.includesCreatedEdit === false &&
          item.isMinimized === false && typeof item.id === 'string' && item.id && timestamp(item.createdAt) > current.after);
      }
      if (!comment) {
        issues.push({ ...held, reason: 'needs-coordinator-approval' });
        continue;
      }
    }
    issues.push({ ...held, ...route, state: 'ready', prompt: issue.title + '\n\n' + issue.body,
      intake: { issueId: issue.id, hash: current.hash, coordinatorId, commentId: comment?.id ?? null } });
  }
  return issues;
}
