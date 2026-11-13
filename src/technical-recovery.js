import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { terminateTree } from './codex.js';
import { inside } from './worktrees.js';

export const ACTIVE_BUDGET_MS = 60 * 60 * 1000;

export function recoveryPolicy(value, repo, stateDir) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid technical recovery configuration');
  const { limit = 2, verifier, adopt = [] } = value;
  if (!Array.isArray(adopt) || adopt.some(row => !Number.isSafeInteger(row?.number) || row.number < 1 ||
      !['environment', 'code'].includes(row.kind)) || new Set(adopt.map(row => row.number)).size !== adopt.length) {
    throw new Error('Invalid technical recovery adoption list');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2) throw new Error('Technical recovery requires a limit of one or two attempts');
  if (verifier === undefined) return { limit, adopt };
  if (typeof verifier?.path !== 'string' || !isAbsolute(verifier.path) ||
      !/^[a-f0-9]{64}$/.test(verifier.sha256 ?? '')) throw new Error('Verification runner requires an absolute path and SHA-256');
  const path = realpathSync(verifier.path);
  if (inside(repo, path) || inside(stateDir, path)) throw new Error('Keep the approved verifier outside the target and state');
  const read = () => {
    const code = readFileSync(path);
    if (createHash('sha256').update(code).digest('hex') !== verifier.sha256) {
      throw new Error('Verification runner changed after approval');
    }
    return code;
  };
  read();
  return { limit, adopt, verifier: read };
}

export function recoveryScope(issue) {
  return createHash('sha256').update(JSON.stringify([
    issue.prompt, issue.intake?.hash, issue.dependencies, issue.model, issue.reasoning
  ])).digest('hex');
}

export async function verifyTechnical({ readVerifier, cwd, signal, timeoutMs, onRecord }) {
  if (signal?.aborted) return { state: 'stopped', detail: 'cancelled-before-launch' };
  const code = readVerifier();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|pathext|systemroot|windir|systemdrive|comspec|temp|tmp|tmpdir|home|userprofile|homedrive|homepath|username|userdomain|programdata|appdata|localappdata|lang|lc_all)$/i.test(key)));
  const child = spawn(process.execPath, ['--input-type=module', '-'], {
    cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'ignore', 'ignore']
  });
  return new Promise(resolve => {
    let stopping, termination, spawnFailed, exited = false;
    function stop(reason) {
      if (stopping || exited) return;
      stopping = reason;
      termination = terminateTree(child.pid);
    }
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('verification-timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.on('error', () => {});
    child.on('error', () => { spawnFailed = true; });
    child.on('exit', () => { exited = true; });
    child.once('spawn', () => {
      try {
        if (stopping) return child.stdin.end();
        onRecord({ type: 'worker-started', pid: child.pid });
        child.stdin.end(code);
      } catch { stop('recording-failed'); }
    });
    child.once('close', async code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (stopping) {
        if (!await termination) return resolve({ state: 'interrupted', detail: 'process-tree-exit-unconfirmed' });
        if (stopping !== 'verification-timeout') {
          return resolve({ state: stopping === 'cancelled' ? 'stopped' : 'failed', detail: stopping });
        }
      }
      if (!stopping && !spawnFailed && code === 0) return resolve({ state: 'done', detail: 'verification-passed' });
      const technicalBlocker = !stopping && !spawnFailed && code === 10 ? 'code' : 'environment';
      resolve({ state: 'blocked', detail: 'verification-' + technicalBlocker + '-failure', code, result: { technicalBlocker } });
    });
  });
}
