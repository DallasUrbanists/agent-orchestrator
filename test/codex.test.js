import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { codexArgs, jsonLines, MODELS, runCodex } from '../src/codex.js';

const thread = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const encode = event => JSON.stringify(event) + '\n';

function fixture(overrides = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 1234, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()
  });
  const events = [];
  let input = '';
  child.stdin.setEncoding('utf8').on('data', chunk => { input += chunk; });
  const options = {
    executable: 'native-codex', model: 'sol', cwd: 'directory with spaces',
    prompt: 'Literal task $(no-shell); & $env:TEST', timeoutMs: 500,
    onRecord: record => events.push(record), ...overrides
  };
  function spawn(command, args, spawnOptions) {
    assert.equal(command, options.executable);
    assert.equal(args.includes(options.prompt), false);
    assert.equal(spawnOptions.cwd, options.cwd);
    assert.equal(spawnOptions.shell, false);
    assert.equal(spawnOptions.env.GITHUB_TOKEN, undefined);
    return child;
  }
  return { child, options, events, spawn, input: () => input };
}

test('routes only Terra and Sol and builds an explicit sandboxed argument array', () => {
  for (const [model, id] of Object.entries(MODELS)) {
    const args = codexArgs(model, 'directory with spaces');
    assert.equal(args[args.indexOf('--model') + 1], id);
    assert.equal(args[args.indexOf('--cd') + 1], 'directory with spaces');
    assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.ok(args.includes('--json'));
    assert.equal(args.at(-1), '-');
    assert.ok(args.includes('approval_policy="never"'));
    assert.equal(args.some(arg => /bypass|astra/i.test(arg)), false);
  }
  assert.throws(() => codexArgs('astra', 'x'), /terra or sol/);
  assert.throws(() => codexArgs('constructor', 'x'), /terra or sol/);
});

test('parses split, malformed, oversized and unterminated JSONL records', () => {
  const events = [];
  let malformed = 0;
  const parser = jsonLines(event => events.push(event.type), () => malformed++, 40);
  parser.push('{"type":"');
  parser.push('first"}\r\nbad\n' + 'x'.repeat(60));
  parser.push('still oversized\n{"type":"last"}');
  parser.finish();
  assert.deepEqual(events, ['first', 'last']);
  assert.equal(malformed, 2);
});

test('passes prompt via stdin, returns result and exit code, and omits raw output from logs', async () => {
  const { child, options, spawn, events, input } = fixture();
  const run = runCodex(options, spawn);
  child.stdout.write(encode({ type: 'thread.started', thread_id: thread }));
  child.stdout.write(encode({ type: 'item.completed', item: { type: 'agent_message',
    text: '{"outcome":"done","summary":"sensitive command output"}' } }));
  child.stdout.write(encode({ type: 'turn.completed' }).trim());
  child.stderr.write('sensitive token');
  child.emit('close', 0, null);
  assert.equal(input(), options.prompt);
  assert.deepEqual(await run, { state: 'done', detail: null, code: 0, signal: null,
    threadId: thread, result: { outcome: 'done', summary: 'sensitive command output' } });
  assert.ok(events.some(event => event.threadId === thread));
  assert.doesNotMatch(JSON.stringify(events), /sensitive|Literal task/);
});

test('distinguishes nonzero exit and a truncated successful exit', async () => {
  for (const code of [1, 0]) {
    const { child, options, spawn } = fixture();
    const run = runCodex(options, spawn);
    child.stdout.write('{"type":"turn');
    child.emit('close', code, null);
    const result = await run;
    assert.equal(result.state, 'failed');
    assert.equal(result.code, code);
    assert.equal(result.detail, code ? 'codex-exit-or-turn-failed' : 'incomplete-codex-result');
  }
});

for (const reason of ['timeout', 'cancelled', 'unconfirmed']) {
  test('reports ' + reason + ' and requests process-tree termination', async () => {
    const cancel = new AbortController();
    const { child, options, spawn } = fixture({ signal: cancel.signal, timeoutMs: 20 });
    let terminated = false;
    const run = runCodex(options, spawn, async pid => {
      assert.equal(pid, child.pid);
      terminated = true;
      child.emit('close', 1, null);
      return reason !== 'unconfirmed';
    });
    if (reason !== 'timeout') cancel.abort();
    const result = await run;
    assert.ok(terminated);
    assert.equal(result.state, { timeout: 'failed', cancelled: 'stopped', unconfirmed: 'interrupted' }[reason]);
    assert.equal(result.detail, reason === 'unconfirmed' ? 'process-tree-exit-unconfirmed' : reason);
  });
}
