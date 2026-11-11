/** Deterministic scheduling; this module never runs code or writes to GitHub. */
export const DEFAULT_WORKERS = Object.freeze([
  { id: 'terra-a', model: 'terra', skills: ['ui', 'docs', 'tests', 'general'] },
  { id: 'terra-b', model: 'terra', skills: ['docs', 'tests', 'ui', 'general'] },
  { id: 'sol-c', model: 'sol', skills: ['rendering', 'gis', 'roadway', 'general'] }
]);

const VALID_STATES = new Set(['ready', 'in-progress', 'blocked', 'done']);
const byPriority = (a, b) => (a.priority ?? 99) - (b.priority ?? 99) || a.number - b.number;
export function validateIssues(issues) {
  if (!Array.isArray(issues)) throw new Error('Issues must be an array');
  const ids = new Set();
  for (const issue of issues) {
    if (!Number.isSafeInteger(issue.number) || issue.number <= 0 || ids.has(issue.number)) {
      throw new Error(`Invalid or duplicate issue number: ${issue.number}`);
    }
    ids.add(issue.number);
    if (issue.priority != null && !Number.isSafeInteger(issue.priority)) {
      throw new Error('Invalid priority for #' + issue.number);
    }
    if (!VALID_STATES.has(issue.state)) throw new Error(`Invalid state for #${issue.number}`);
    if (!['terra', 'sol'].includes(issue.model)) throw new Error(`Invalid model for #${issue.number}`);
    if (!Array.isArray(issue.dependencies) || !issue.dependencies.every(Number.isSafeInteger)) {
      throw new Error(`Invalid dependencies for #${issue.number}`);
    }
    if (issue.dependencies.includes(issue.number)) throw new Error(`Self dependency on #${issue.number}`);
  }
  const byId = new Map(issues.map(i => [i.number, i]));
  for (const issue of issues) {
    for (const dep of issue.dependencies) {
      if (!byId.has(dep)) throw new Error(`Missing dependency #${dep} for #${issue.number}`);
    }
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`Dependency cycle involving #${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id).dependencies) visit(dep);
    visiting.delete(id); visited.add(id);
  }
  for (const issue of issues) visit(issue.number);
  return byId;
}

/** Simulates dispatches without mutating inputs or claiming tasks. */
export function plan(issues, workers = DEFAULT_WORKERS, active = []) {
  const byId = validateIssues(issues);
  const activeIssueIds = new Set(active.map(x => x.issue));
  const activeWorkers = new Set(active.map(x => x.worker));
  const assigned = new Set();
  const reservations = new Set(active.flatMap(x => x.paths ?? []));
  const available = issues.filter(issue => issue.state === 'ready' && !activeIssueIds.has(issue.number))
    .sort(byPriority);
  const assignments = [];
  for (const worker of workers) {
    if (activeWorkers.has(worker.id)) continue;
    const candidate = available.find(issue => !assigned.has(issue.number)
      && issue.model === worker.model
      && issue.dependencies.every(dep => byId.get(dep).state === 'done')
      && (!issue.skill || worker.skills.includes(issue.skill))
      && (issue.paths ?? []).every(path => !reservations.has(path)));
    if (!candidate) continue;
    assignments.push({ worker: worker.id, model: worker.model, issue: candidate.number, title: candidate.title });
    assigned.add(candidate.number);
    for (const path of candidate.paths ?? []) reservations.add(path);
  }
  const waiting = available.filter(i => !assigned.has(i.number)).map(issue => ({
    issue: issue.number,
    reason: issue.dependencies.some(dep => byId.get(dep).state !== 'done') ? 'dependency'
      : !workers.some(w => w.model === issue.model && (!issue.skill || w.skills.includes(issue.skill))) ? 'no-matching-worker'
      : (issue.paths ?? []).some(path => reservations.has(path)) ? 'path-reservation-or-capacity'
      : 'worker-capacity'
  }));
  return { assignments, waiting, active, totals: {
    ready: issues.filter(i => i.state === 'ready').length,
    blocked: issues.filter(i => i.state === 'blocked').length,
    inProgress: issues.filter(i => i.state === 'in-progress').length,
    done: issues.filter(i => i.state === 'done').length
  }};
}

/** Returns currently runnable tasks in the order used by the controller. */
export function eligibleIssues(issues, persisted) {
  const byId = new Map(issues.map(issue => [issue.number, issue]));
  return issues.filter(issue => issue.state === 'ready' && !persisted.has(issue.number) &&
    issue.dependencies.every(number => (persisted.get(number) ?? byId.get(number)?.state) === 'done'))
    .sort(byPriority);
}
