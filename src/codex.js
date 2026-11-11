import { spawn, execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODELS = Object.freeze({ terra: 'gpt-6.1-terra', sol: 'gpt-6.1-sol' });
const schema = fileURLToPath(new URL('./outcome.json', import.meta.url));
const windows = process.platform === 'win32';

export function findCodex() {
  const executable = windows ? 'codex.exe' : 'codex';
  if (process.env.ORCHESTRATOR_CODEX) {
    const path = process.env.ORCHESTRATOR_CODEX;
    if (!isAbsolute(path) || !existsSync(path) || (windows && !/\.exe$/i.test(path))) {
      throw new Error('ORCHESTRATOR_CODEX must point to an existing native executable');
    }
    return path;
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
    const direct = join(directory, executable);
    if (existsSync(direct)) return direct;
    if (!windows) continue;
    const vendor = join(directory, 'node_modules', '@openai', 'codex', 'node_modules',
      '@openai', 'codex-win32-' + process.arch, 'vendor');
    if (!existsSync(vendor)) continue;
    for (const entry of readdirSync(vendor)) {
      const native = join(vendor, entry, 'bin', executable);
      if (existsSync(native)) return native;
    }
  }
  throw new Error('Codex executable missing. Install Codex CLI or set ORCHESTRATOR_CODEX');
}

export function sandboxConfigArgs() {
  return ['-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
    ...(windows ? ['-c', 'windows.sandbox="unelevated"'] : [])];
}

export function codexArgs(model, cwd) {
  if (!Object.hasOwn(MODELS, model)) throw new Error('Worker model must be terra or sol');
  return ['exec', '--ignore-user-config', '--model', MODELS[model], '--cd', cwd,
    '--json', '--color', 'never', '--sandbox', 'workspace-write',
    '-c', 'approval_policy="never"', ...sandboxConfigArgs(),
    '-c', 'web_search="disabled"', '-c', 'shell_environment_policy.inherit="core"',
    ...(model === 'sol' ? ['-c', 'model_reasoning_effort="high"'] : []),
    '--output-schema', schema, '-'];
}

// Keep host and Codex login location settings. Drop application and GitHub tokens.
function workerEnv() {
  const allowed = /^(path|pathext|systemroot|windir|systemdrive|comspec|temp|tmp|tmpdir|home|userprofile|homedrive|homepath|username|userdomain|programdata|programfiles(\(x86\))?|appdata|localappdata|lang|lc_all|codex_home)$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
}

export function jsonLines(onEvent, onMalformed, maxLength = 1024 * 1024) {
  let line = '';
  let overflow = false;
  function finish() {
    if (overflow) onMalformed();
    else if (line.trim()) {
      let event;
      try { event = JSON.parse(line); } catch { /* Report malformed JSON below. */ }
      if (typeof event?.type === 'string') onEvent(event);
      else onMalformed();
    }
    line = '';
    overflow = false;
  }
  return {
    push(chunk) {
      const parts = chunk.split('\n');
      for (const [index, part] of parts.entries()) {
        if (line.length + part.length > maxLength) overflow = true;
        if (!overflow) line += part;
        if (index < parts.length - 1) finish();
      }
    },
    finish
  };
}

export function terminateTree(pid) {
  if (!pid) return Promise.resolve(false);
  if (windows) {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    return new Promise(resolve => {
      execFile(taskkill, ['/pid', String(pid), '/t', '/f'],
        { windowsHide: true, timeout: 5000 }, error => resolve(!error));
    });
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group may have already exited.
  }
  // A detached descendant can outlive the original process group.
  return Promise.resolve(false);
}

const eventTypes = new Set(['thread.started', 'turn.started', 'turn.completed', 'turn.failed',
  'item.started', 'item.updated', 'item.completed', 'error']);
const itemTypes = new Set(['agent_message', 'reasoning', 'command_execution', 'file_change',
  'mcp_tool_call', 'web_search', 'todo_list', 'error']);
const sessionPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const diagnostics = [
  ['network', /failed to (connect|resolve)|error sending request|stream disconnected|connection refused|dns error|10013/i],
  ['authentication', /unauthorized|failed to refresh|invalid token|authentication|401 unauthorized/i],
  ['model', /model.{0,100}(not supported|not found|unavailable|does not exist)/i],
  ['sandbox', /sandbox.{0,100}(denied|failed|error|disabled|not supported)|access is denied/i],
  ['rate-limit', /rate limit|usage limit|429 too many/i]
];

export function runCodex({ executable, cwd, model, prompt, timeoutMs, signal,
  onRecord = () => {} }, spawnChild = spawn, killTree = terminateTree) {
  if (signal?.aborted) return Promise.resolve({ state: 'stopped', detail: 'cancelled-before-launch' });
  const args = codexArgs(model, cwd);
  return new Promise(resolve => {
    let child;
    try {
      child = spawnChild(executable, args, {
        cwd, env: workerEnv(), shell: false, windowsHide: true, detached: !windows
      });
    } catch {
      resolve({ state: 'failed', detail: 'spawn-error' });
      return;
    }
    let threadId, final, timer, grace, stopReason, termination;
    let completed = false;
    let turnFailed = false;
    let spawnFailed = false;
    let finished = false;
    let rootExited = false;
    let closed = false;
    let recordingFailed = false;
    const found = new Set();

    function record(event) {
      if (recordingFailed) return;
      try {
        onRecord(event);
      } catch {
        recordingFailed = true;
        stop('recording-failed');
      }
    }
    function diagnose(value) {
      for (const [name, pattern] of diagnostics) {
        if (pattern.test(value) && !found.has(name)) {
          found.add(name);
          record({ type: 'diagnostic', category: name });
        }
      }
    }
    const parser = jsonLines(event => {
      if (event.type === 'thread.started' && sessionPattern.test(event.thread_id)) threadId = event.thread_id;
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'turn.failed') turnFailed = true;
      if (event.type === 'turn.failed' || event.type === 'error') {
        diagnose(String(event.error?.message ?? event.message ?? ''));
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        final = event.item.text;
      }
      record({
        type: eventTypes.has(event.type) ? event.type : 'unknown-event',
        ...(threadId && event.type === 'thread.started' ? { threadId } : {}),
        ...(itemTypes.has(event.item?.type) ? { itemType: event.item.type } : {}),
        ...(Number.isInteger(event.item?.exit_code) ? { commandExit: event.item.exit_code } : {})
      });
    }, () => record({ type: 'malformed-output' }));

    function finish(state, detail, code = null, processSignal = null, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener('abort', cancel);
      record({ type: 'worker-exit', state, detail, code, signal: processSignal });
      if (recordingFailed && state !== 'interrupted' && state !== 'stopped') {
        resolve({ state: 'failed', detail: 'recording-failed', code, signal: processSignal, threadId });
        return;
      }
      resolve({ state, detail, code, signal: processSignal, threadId, result });
    }

    function stop(reason) {
      if (finished || closed || stopReason) return;
      stopReason = reason;
      termination = Promise.resolve().then(() => !rootExited && killTree(child.pid)).catch(() => false);
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        child.unref();
        finish('interrupted', 'process-tree-exit-unconfirmed');
      }, 8000);
    }

    function cancel() { stop('cancelled'); }

    child.stdout.setEncoding('utf8').on('data', chunk => { if (!finished) parser.push(chunk); });
    child.stderr.setEncoding('utf8').on('data', chunk => { if (!finished) diagnose(chunk); });
    child.stdin.on('error', () => { if (!finished) record({ type: 'stdin-error' }); });
    child.once('error', () => { spawnFailed = true; });
    child.once('exit', () => { rootExited = true; });
    child.once('close', async (code, processSignal) => {
      if (finished) return;
      closed = true;
      if (stopReason) {
        if (!await termination) return finish('interrupted', 'process-tree-exit-unconfirmed', code, processSignal);
        return finish(stopReason === 'cancelled' ? 'stopped' : 'failed', stopReason, code, processSignal);
      }
      // Flush the last partial line after the process exits. A failed write here
      // cannot trigger process-tree termination because its PID may be reused.
      parser.finish();
      if (recordingFailed) {
        return finish('failed', 'recording-failed', code, processSignal);
      }
      if (code !== 0 || turnFailed) {
        const detail = spawnFailed ? 'spawn-error' : [...found].join(', ') || 'codex-exit-or-turn-failed';
        return finish('failed', detail, code, processSignal);
      }
      let result;
      try { result = JSON.parse(final); } catch { /* Missing or malformed result. */ }
      if (!completed || !threadId || !['done', 'blocked'].includes(result?.outcome) || typeof result.summary !== 'string') {
        return finish('failed', 'incomplete-codex-result', code);
      }
      finish(result.outcome, result.outcome === 'blocked' ? 'worker-reported-blocker' : null, code, null, result);
    });
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    record({ type: 'worker-started', pid: child.pid ?? null });
    if (stopReason) child.stdin.end();
    else child.stdin.end(prompt, 'utf8');
  });
}
