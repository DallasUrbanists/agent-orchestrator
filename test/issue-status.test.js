import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HEARTBEAT_MS, observeProgress, statusPublisher } from '../src/issue-status.js';
import { State } from '../src/state.js';

const repo = 'fixture/status';
const origin = 'https://github.com/' + repo;
const t0 = Date.parse('2026-01-01T00:00:00Z');
const instant = ms => new Date(t0 + ms).toISOString();

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'orchestrator-progress-'));
  let state = new State(directory);
  t.after(() => { state.close(); rmSync(directory, { recursive: true, force: true }); });
  state.bind(directory, repo);
  const branch = 'orchestrator/github-issue-1';
  const attempt = state.reserve({ number: 1, repo: directory, worker: 'local-1', model: 'fixture',
    location: { path: directory, branch }, log: join(directory, 'log'), base: 'base' });
  const labels = new Set(['keep-me']);
  const comments = [];
  let pull, issueState = 'open';
  let posts = 0, edits = 0;
  let postFailure, removeFailure;
  const api = {
    async viewer() { return 101; },
    async issue() { return { number: 1, html_url: origin + '/issues/1', state: issueState,
      labels: [...labels].map(name => ({ name })) }; },
    async openPulls() { return pull ? [pull] : []; },
    async add(_repo, _number, label) { labels.add(label); },
    async remove(_repo, _number, label) {
      if (removeFailure) throw new Error('transient');
      labels.delete(label);
    },
    async comments() { return structuredClone(comments); },
    async post(_repo, _number, body) {
      posts++;
      if (postFailure === 'rejected') throw Object.assign(new Error('rejected'), { status: 403 });
      const created = { id: posts, user: { id: 101 }, body };
      comments.push(created);
      if (postFailure === 'lost') throw new Error('response lost');
      return created;
    },
    async edit(_repo, id, body) { edits++; comments.find(item => item.id === id).body = body; }
  };
  let now = instant(0);
  const publisher = () => statusPublisher(state, repo, { api, clock: () => now });
  return {
    attempt, labels, comments, publisher,
    get state() { return state; }, get posts() { return posts; }, get edits() { return edits; },
    set postFailure(value) { postFailure = value; }, set removeFailure(value) { removeFailure = value; },
    restart() { state.close(); state = new State(directory); },
    time(ms) { now = instant(ms); },
    closeIssue() { issueState = 'closed'; },
    observe(event, ms) { return observeProgress(state, attempt, event, instant(ms)); },
    finish(outcome) { state.finish(1, attempt, { state: outcome }); },
    handoff() {
      const side = ref => ({ ref, repo: { full_name: repo } });
      pull = { number: 4, state: 'open', html_url: origin + '/pull/4', head: side(branch), base: side('main') };
    }
  };
}

test('launch opens one comment and the five-minute update reports observed activity and quiet time', async t => {
  const f = fixture(t);
  const { sync } = f.publisher();
  await sync(1);
  assert.deepEqual([...f.labels], ['keep-me']);
  assert.equal(f.posts, 0);
  assert.equal(f.observe({ type: 'worker-started', pid: null }, 0), false);
  assert.equal(f.observe({ type: 'worker-started', pid: 321 }, 0), true);
  await sync(1);
  assert.deepEqual([...f.labels], ['keep-me', 'in-progress']);
  assert.match(f.comments[0].body, /No activity observed since launch/);
  f.observe({ type: 'item.completed', itemType: 'command_execution', output: 'ghp_private @everyone' }, 1000);
  f.time(HEARTBEAT_MS + 1000);
  await sync(1);
  assert.equal(f.posts, 1);
  assert.equal(f.edits, 1);
  assert.match(f.comments[0].body, /Elapsed: 5m 1s/);
  assert.match(f.comments[0].body, /Last observed activity: 2026-01-01T00:00:01.000Z/);
  assert.match(f.comments[0].body, /No new activity observed/);
  assert.match(f.comments[0].body, /A local command finished/);
  assert.doesNotMatch(f.comments[0].body, /ghp_private|@everyone/);

  f.finish('done');
  await sync(1);
  assert.deepEqual([...f.labels], ['keep-me']);
  assert.match(f.comments[0].body, /Awaiting PR handoff/);
  f.handoff();
  f.restart();
  await f.publisher().sync(1);
  assert.deepEqual([...f.labels], ['keep-me', 'in-review']);
  assert.equal(f.posts, 1);
  assert.match(f.comments[0].body, /https:\/\/github.com\/fixture\/status\/pull\/4/);
  assert.equal(f.state.githubProgress(1)[0].comment, f.comments[0].id);
});

test('adopts a comment after a lost create response and retries failed label updates', async t => {
  const f = fixture(t);
  f.observe({ type: 'worker-started', pid: 321 }, 0);
  f.postFailure = 'lost';
  await f.publisher().sync(1);
  assert.equal(f.state.githubProgress(1)[0].comment, null);
  assert.equal(f.state.githubProgress(1)[0].posting, 1);
  f.finish('blocked');
  f.restart();
  f.removeFailure = true;
  await f.publisher().sync(1);
  assert.equal(f.state.githubStatusRows()[0].error, 'label-update-failed');
  assert.equal(f.state.githubProgress(1)[0].comment, f.comments[0].id);
  assert.match(f.comments[0].body, /Blocked/);
  f.removeFailure = false;
  await f.publisher().sync(1);
  assert.equal(f.posts, 1);
  assert.deepEqual([...f.labels], ['keep-me', 'blocked']);
  assert.equal(f.state.githubStatusRows()[0].error, null);
});

test('retries a definite create rejection and leaves an interrupted attempt on its original comment', async t => {
  const f = fixture(t);
  f.observe({ type: 'worker-started', pid: 321 }, 0);
  f.postFailure = 'rejected';
  await f.publisher().sync(1);
  assert.equal(f.comments.length, 0);
  assert.equal(f.state.githubProgress(1)[0].posting, 0);
  f.postFailure = null;
  await f.publisher().sync(1);
  const id = f.comments[0].id;
  f.restart();
  f.state.recover();
  await f.publisher().all();
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].id, id);
  assert.match(f.comments[0].body, /Interrupted/);
  assert.deepEqual([...f.labels], ['keep-me', 'blocked']);
});

test('a closed issue retains its labels and receives the final comment edit', async t => {
  const f = fixture(t);
  f.observe({ type: 'worker-started', pid: 321 }, 0);
  await f.publisher().sync(1);
  f.closeIssue();
  f.finish('failed');
  await f.publisher().sync(1);
  assert.deepEqual([...f.labels], ['keep-me', 'in-progress']);
  assert.equal(f.posts, 1);
  assert.match(f.comments[0].body, /Failed/);
});
