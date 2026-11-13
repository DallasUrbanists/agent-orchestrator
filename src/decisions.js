import { randomUUID } from 'node:crypto';

const validKey = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value) && value === value.trim();
const positiveId = value => Number.isSafeInteger(value) && value > 0;

function text(value, max, multiline = false) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max &&
    (multiline || !/[\r\n]/.test(value));
}

export function responderIds(queue) {
  const ids = queue.authorizedResponders;
  if (!Array.isArray(ids) || !ids.length || !ids.every(positiveId)) {
    throw new Error('GitHub decisions require authorizedResponders with numeric GitHub account IDs');
  }
  return new Set(ids);
}

export function reviewedDecisions(issue) {
  const decisions = issue.decisions ?? [];
  if (!Array.isArray(decisions) || decisions.length > 10) {
    throw new Error('Invalid reviewed decisions for task #' + issue.number);
  }
  const keys = new Set();
  return decisions.map(item => {
    if (!validKey(item?.key) || keys.has(item.key) || !text(item.question, 2000, true) ||
        !Array.isArray(item.choices) || item.choices.length < 2 || item.choices.length > 10) {
      throw new Error('Invalid reviewed decision for task #' + issue.number);
    }
    keys.add(item.key);
    const choices = new Set();
    const options = item.choices.map(choice => {
      if (!validKey(choice?.id) || choices.has(choice.id) ||
          !text(choice.label, 250) || !text(choice.instruction, 4000, true)) {
        throw new Error('Invalid reviewed decision choice for task #' + issue.number);
      }
      choices.add(choice.id);
      return { id: choice.id, label: choice.label.trim(), instruction: choice.instruction.trim() };
    });
    return { key: item.key, question: item.question.replace(/\r\n/g, '\n').trim(), choices: options };
  });
}

export function decisionRequest(templates, key) {
  const template = templates.find(item => item.key === key);
  return template ? { id: randomUUID(), key, template } : null;
}

export function decisionBody(decision) {
  const template = JSON.parse(decision.template);
  return ['**Agent Orchestrator decision**', '', template.question, '',
    'Reply with exactly one of these commands:', '',
    ...template.choices.map(choice => '- `/orchestrator decide ' + decision.id + ' ' + choice.id +
      '` — ' + choice.label),
    '', '<!-- agent-orchestrator-decision:' + decision.id + ' -->'].join('\n');
}

export function approvedInstruction(decision) {
  return JSON.parse(decision.template).choices.find(choice => choice.id === decision.choice).instruction;
}

function requestMatches(comment, actor, body) {
  return positiveId(comment?.id) && comment.user?.id === actor && comment.body === body &&
    Number.isFinite(Date.parse(comment.created_at));
}

export function authorizedAnswer(comments, posted, decision, responders) {
  const options = JSON.parse(decision.template).choices.map(choice => choice.id);
  const prefix = '/orchestrator decide ' + decision.id + ' ';
  const postedAt = Date.parse(posted.created_at);
  const eligible = comments.filter(comment => {
    const created = Date.parse(comment?.created_at);
    return positiveId(comment?.id) && comment.user?.type === 'User' && responders.has(comment.user.id) &&
      comment.updated_at === comment.created_at &&
      (created > postedAt || (created === postedAt && comment.id > posted.id)) &&
      typeof comment.body === 'string' && options.some(option => comment.body.trim() === prefix + option);
  });
  const first = eligible.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)[0];
  return first && { comment: first.id, author: first.user.id, choice: first.body.trim().slice(prefix.length) };
}

export async function syncDecisions(state, repo, requests, { api, responders, signal, canContinue }) {
  const verified = new Set();
  if (!requests.length || !canContinue()) return verified;
  const options = { signal };
  let actor;
  try { actor = await api.viewer(options); }
  catch {
    for (const row of requests) state.decisionError(row.id, 'github-account-unavailable');
    return verified;
  }
  for (const row of requests) {
    if (!canContinue()) return verified;
    if (row.publisher_id && row.publisher_id !== actor) {
      state.decisionError(row.id, 'publisher-account-changed');
      continue;
    }
    let comments;
    try { comments = await api.comments(repo, row.number, options); }
    catch {
      state.decisionError(row.id, 'comments-unavailable');
      continue;
    }
    if (!canContinue()) return verified;

    const body = decisionBody(row);
    const posted = comments.find(comment => requestMatches(comment, actor, body) &&
      (!row.request_comment || row.request_comment === comment.id));
    if (posted) {
      state.decisionPosted(row.id, posted.id);
      const saved = row.reply_comment && authorizedAnswer(
        comments.filter(comment => comment?.id === row.reply_comment), posted, row, responders
      );
      if (saved && saved.author === row.responder_id && saved.choice === row.choice) {
        verified.add(row.id);
        continue;
      }
      // A replacement must be newer than the invalidated reply.
      const candidates = row.reply_comment ? comments.filter(comment => comment?.id > row.reply_comment) : comments;
      const answer = authorizedAnswer(candidates, posted, row, responders);
      if (answer) {
        state.answerDecision(row.id, answer, row.reply_comment);
        verified.add(row.id);
      } else if (row.reply_comment) {
        state.decisionError(row.id, 'saved-reply-no-longer-authorized');
      }
      continue;
    }
    if (row.request_comment || row.posting) {
      state.decisionError(row.id, row.request_comment ? 'request-comment-unavailable' : 'delivery-unconfirmed');
      continue;
    }

    state.beginDecisionPost(row.id, actor);
    let created;
    try { created = await api.post(repo, row.number, body, options); }
    catch {
      state.decisionError(row.id, 'delivery-unconfirmed');
      continue;
    }
    if (requestMatches(created, actor, body)) state.decisionPosted(row.id, created.id);
    else state.decisionError(row.id, 'delivery-unconfirmed');
  }
  return verified;
}
