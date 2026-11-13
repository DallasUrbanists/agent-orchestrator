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
  const { limit = 2, verifier, hostVerification, adopt = [], blockerTasks = [] } = value;
  if (!Array.isArray(adopt) || adopt.some(row => !Number.isSafeInteger(row?.number) || row.number < 1 ||
      !['environment', 'code'].includes(row.kind)) || new Set(adopt.map(row => row.number)).size !== adopt.length) {
    throw new Error('Invalid technical recovery adoption list');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2) throw new Error('Technical recovery requires a limit of one or two attempts');
  if (!Array.isArray(blockerTasks) || blockerTasks.some(task =>
    !Number.isSafeInteger(task?.number) || task.number < 1 ||
    !Number.isSafeInteger(task.afterAttempt) || task.afterAttempt < 1 ||
    typeof task.instruction !== 'string' || !task.instruction.trim() || task.instruction.length > 2000) ||
    new Set(blockerTasks.map(task => task.number)).size !== blockerTasks.length ||
    (blockerTasks.length && !hostVerification)) throw new Error('Invalid blocker task configuration');
  if (hostVerification !== undefined) {
    if (verifier !== undefined) throw new Error('Choose either a single verifier or project host verification profiles');
    const { runner, profiles, issues, toolchain = {} } = hostVerification ?? {};
    if (!runner || !profiles || typeof profiles !== 'object' || Array.isArray(profiles) ||
        !Array.isArray(issues) || !issues.length || !toolchain || typeof toolchain !== 'object' ||
        Array.isArray(toolchain) || Object.entries(toolchain).some(([key, entry]) =>
          !/^[a-z][a-zA-Z0-9]{0,39}$/.test(key) || typeof entry !== 'string' || !entry || entry.length > 4096
        )) throw new Error('Host verification requires a runner, profiles and issue bindings');
    const base = recoveryPolicy({ verifier: { ...runner, number: 1 } }, repo, stateDir).verifierFor(1);
    const byIssue = new Map();
    for (const row of issues) {
      const { profile, resumeImplementation = false } = row ?? {};
      const evidence = typeof profile === 'string' && Object.hasOwn(profiles, profile) ? profiles[profile] : null;
      if (!Number.isSafeInteger(row?.number) || row.number < 1 || byIssue.has(row.number) || typeof resumeImplementation !== 'boolean' ||
          !/^[a-z][a-z0-9-]{0,63}$/.test(profile ?? '') ||
          typeof evidence !== 'string' || !evidence.trim() || evidence.length > 2000) {
        throw new Error('Host verification issue bindings require a unique issue and reviewed profile');
      }
      byIssue.set(row.number, {
        evidence, resumeImplementation,
        read: () => Buffer.concat([Buffer.from('const orchestratorProfile = ' + JSON.stringify(profile) +
          ';\nconst orchestratorToolchain = ' + JSON.stringify(toolchain) + ';\n'), base()])
      });
    }
    if (blockerTasks.some(task => !byIssue.has(task.number))) throw new Error('Blocker task needs an approved host profile');
    return { limit, adopt, blockerTasks: new Map(blockerTasks.map(task => [task.number, task])),
      verifierFor: issue => byIssue.get(issue)?.read,
      profileEvidence: issue => byIssue.get(issue)?.evidence,
      resumeImplementation: issue => byIssue.get(issue)?.resumeImplementation };
  }
  if (verifier === undefined) return { limit, adopt, verifierFor: () => null };
  if (!Number.isSafeInteger(verifier?.number) || verifier.number < 1 ||
      typeof verifier.path !== 'string' || !isAbsolute(verifier.path) ||
      !/^[a-f0-9]{64}$/.test(verifier.sha256 ?? '')) throw new Error('Verification runner requires an issue number, absolute path, and SHA-256');
  const { number, path, sha256 } = verifier;
  if (inside(repo, path) || inside(stateDir, path)) throw new Error('Keep the approved verifier outside the target and state');
  const read = () => {
    const resolved = realpathSync(path);
    if (inside(repo, resolved) || inside(stateDir, resolved)) {
      throw new Error('Approved verification runner redirects into the target or state');
    }
    const code = readFileSync(resolved);
    if (createHash('sha256').update(code).digest('hex') !== sha256) {
      throw new Error('Verification runner changed after approval');
    }
    return code;
  };
  return { limit, adopt, verifierFor: issue => issue === number ? read : null };
}

export function recoveryScope(issue) {
  return createHash('sha256').update(JSON.stringify([
    issue.prompt, issue.intake?.hash, issue.dependencies, issue.model, issue.reasoning
  ])).digest('hex');
}

const MAX_EVIDENCE_BYTES = 16 * 1024;

function measuredChecks(output) {
  const report = JSON.parse(output);
  if (!Array.isArray(report) || !report.length || report.length > 30 || report.some(check =>
    typeof check?.name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(check.name) ||
    !Object.hasOwn(check, 'measurements') || !check.measurements || typeof check.measurements !== 'object' ||
    Array.isArray(check.measurements) || !Object.keys(check.measurements).length ||
    Object.keys(check.measurements).length > 12 ||
    Object.entries(check.measurements).some(([key, value]) => !/^[a-z][a-z0-9-]{0,39}$/.test(key) ||
      !(Number.isSafeInteger(value) || (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)))))) {
    throw new Error('Invalid measured checks');
  }
  if (new Set(report.map(check => check.name)).size !== report.length) throw new Error('Duplicate measured check');
  return report.map(({ name, measurements }) => '- ' + name + ' — ' +
    Object.entries(measurements).map(([key, value]) => key + ' ' + value).join(', ')).join('\n');
}

export async function verifyTechnical({ verifierCode, cwd, signal, timeoutMs, onRecord, collectEvidence = false }) {
  if (signal?.aborted) return { state: 'stopped', detail: 'cancelled-before-launch' };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|pathext|systemroot|windir|systemdrive|comspec|temp|tmp|tmpdir|home|userprofile|homedrive|homepath|username|userdomain|programdata|appdata|localappdata|lang|lc_all)$/i.test(key)));
  const child = spawn(process.execPath, ['--input-type=module', '-'], {
    cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', collectEvidence ? 'pipe' : 'ignore', 'ignore']
  });
  return new Promise(resolve => {
    let stopping, termination, spawnFailed, exited = false;
    let output = Buffer.alloc(0), oversized = false;
    child.stdout?.on('data', chunk => {
      oversized ||= output.length + chunk.length > MAX_EVIDENCE_BYTES;
      if (!oversized) output = Buffer.concat([output, chunk]);
    });
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
        child.stdin.end(verifierCode);
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
      if (!stopping && !spawnFailed && code === 0) {
        let evidence;
        try {
          if (oversized) throw new Error('Measured checks exceed the output limit');
          const report = output.toString('utf8').trim();
          if (report) evidence = measuredChecks(report);
        } catch {
          return resolve({ state: 'blocked', detail: 'invalid-verification-evidence' });
        }
        return resolve({ state: 'done', detail: 'verification-passed', ...(evidence && { evidence }) });
      }
      const technicalBlocker = !stopping && !spawnFailed && code === 10 ? 'code' : 'environment';
      resolve({ state: 'blocked', detail: 'verification-' + technicalBlocker + '-failure', code, result: { technicalBlocker } });
    });
  });
}
