import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

// The coordinator supplies this project-local profile name from its trusted configuration.
const profile = orchestratorProfile;
const worktree = realpathSync(process.cwd());
const report = { profile, runs: [] };
const outputRoot = join(worktree, 'out', 'verification');
const local = join(worktree, '.local');
const { node, npm, chrome } = orchestratorToolchain;
const version = '4.0.542';
const compositor = join(worktree, 'node_modules/@remotion/compositor-win32-x64-msvc');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
let evidence;
let phase = 'environment';

function run(name, executable, args, { fail = false, timeout = 120000 } = {}) {
  const result = spawnSync(executable, args, {
    cwd: worktree, windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PATH: dirname(node) + ';' + process.env.PATH, GSTORY_CHROME: chrome,
      npm_config_ignore_scripts: 'true' }
  });
  writeFileSync(join(evidence, name + '.log'), (result.stdout ?? '') + (result.stderr ?? '') + (result.error?.message ?? ''));
  if (result.error || result.signal) throw Object.assign(new Error(name + ' could not complete'), { environment: true });
  const diagnostic = (result.stdout ?? '') + (result.stderr ?? '');
  if ((fail ? result.status !== 1 : result.status !== 0)) {
    throw Object.assign(new Error(name + ' exited with ' + result.status), {
      environment: /spawn (?:EPERM|EACCES)|EAI_AGAIN|ENOSPC|GPU process isn't usable|Could not find Chrome|failed to launch (?:the )?browser/i.test(diagnostic)
    });
  }
  return diagnostic;
}

function inspectRun(before, name, validate) {
  assert.equal(relative(outputRoot, realpathSync(outputRoot)), '');
  const added = readdirSync(outputRoot, { withFileTypes: true }).filter(entry => !before.has(entry.name));
  assert.equal(added.length, 1, name + ' must create one fresh verification run');
  assert.equal(added[0].isDirectory(), true);
  const location = join(outputRoot, added[0].name);
  assert.equal(relative(location, realpathSync(location)), '');
  try {
    const receipt = JSON.parse(readFileSync(join(location, 'receipt.json'), 'utf8'));
    validate(location, receipt);
    report.runs.push({ name, runId: added[0].name, receiptSha256: hash(join(location, 'receipt.json')) });
  } finally {
    renameSync(location, join(evidence, name + '-' + added[0].name));
  }
}

function exportRun(name, args, validate) {
  const before = new Set(existsSync(outputRoot) ? readdirSync(outputRoot) : []);
  try {
    run(name, node, [npm, 'run', 'render:fixture', '--', ...args], { timeout: 25 * 60000 });
    inspectRun(before, name, (folder, receipt) => {
      assert.equal(receipt.status, 'passed');
      validate(folder, receipt);
    });
  } catch (error) {
    if (existsSync(outputRoot) && !relative(outputRoot, realpathSync(outputRoot))) {
      for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
        if (before.has(entry.name) || !entry.isDirectory()) continue;
        const path = join(outputRoot, entry.name);
        if (!relative(path, realpathSync(path))) renameSync(path, join(evidence, 'failed-' + name + '-' + entry.name));
      }
    }
    throw error;
  }
}

async function main() {
  if (process.platform !== 'win32' || profile !== 'full-render-decode') throw new Error('Unsupported host or profile');
  for (const path of [node, npm, chrome]) assert.ok(typeof path === 'string' && isAbsolute(path));
  mkdirSync(local, { recursive: true });
  assert.equal(relative(local, realpathSync(local)), '');
  evidence = mkdtempSync(join(local, 'host-render-'));
  assert.equal(run('node-version', node, ['--version']).trim(), 'v24.22.1');
  assert.equal(run('npm-version', node, [npm, '--version']).trim(), '11.19.1');
  const chromeVersion = run('chromium-version', 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', "(Get-Item -LiteralPath '" + chrome + "').VersionInfo.ProductVersion"]).trim();
  assert.equal(chromeVersion, '156.0.8078.4');
  run('install', node, [npm, 'ci', '--ignore-scripts', '--no-fund', '--no-audit']);
  for (const pkg of ['@remotion/bundler', '@remotion/renderer', '@remotion/compositor-win32-x64-msvc']) {
    assert.equal(JSON.parse(readFileSync(join(worktree, 'node_modules', pkg, 'package.json'), 'utf8')).version, version);
  }
  const ffmpeg = join(compositor, 'ffmpeg.exe'), ffprobe = join(compositor, 'ffprobe.exe');
  assert.equal(hash(ffmpeg), '5d1aa3706022b2f1814993c7108ca689a0a2e6fe9af91ec15dbf0bc05d6d39e4');
  assert.equal(hash(ffprobe), '66468651d02cec1beac8003fcb4aec42363390810ca4435165ef3cf1439c7261');
  run('ffmpeg-version', ffmpeg, ['-version']);
  run('ffprobe-version', ffprobe, ['-version']);
  report.toolchain = { node: '24.22.1', npm: '11.19.1', chromium: chromeVersion, remotion: version };
  phase = 'code';
  const manifest = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts?.['render:fixture'], 'node scripts/render-fixture.mjs');
  for (const [variant, width, height] of [['portrait', 1080, 1920], ['landscape', 1920, 1080]]) {
    exportRun(variant, ['--format', variant], (folder, receipt) => {
      const directory = join(folder, 'videos');
      assert.equal(relative(directory, realpathSync(directory)), '');
      const names = readdirSync(directory, { withFileTypes: true }).filter(file => file.isFile() && file.name.endsWith('.mp4'));
      assert.equal(names.length, 1);
      const video = join(directory, names[0].name);
      assert.ok(receipt && typeof receipt === 'object');
      const probe = JSON.parse(run(variant + '-metadata', ffprobe, ['-v', 'error', '-select_streams', 'v:0',
        '-count_frames', '-show_entries', 'stream=width,height,avg_frame_rate,nb_read_frames', '-of', 'json', video]));
      const info = probe.streams?.[0];
      assert.deepEqual(info, { width, height, avg_frame_rate: '30/1', nb_read_frames: '300' });
      const decoded = run(variant + '-decode', ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-i', video,
        '-map', '0:v:0', '-f', 'framehash', '-'], { timeout: 180000 });
      const hashes = decoded.split(/\r?\n/).filter(line => /^\s*0,/.test(line)).map(line => line.split(',').at(-1).trim());
      assert.equal(hashes.length, 300);
      assert.equal(new Set([hashes[0], hashes[149], hashes[299]]).size, 3);
      report[variant] = { width, height, frames: hashes.length, rate: '30/1', sha256: hash(video),
        representativeFrameHashes: [0, 149, 299].map(frame => ({ frame, sha256: hashes[frame] })) };
    });
  }
  exportRun('diagnostic', ['--format', 'portrait', '--frames', '0,1,149,150,299'], folder => {
    const directory = join(folder, 'frames');
    assert.equal(relative(directory, realpathSync(directory)), '');
    const files = readdirSync(directory, { withFileTypes: true }).filter(file => file.isFile() && file.name.endsWith('.png'));
    assert.equal(files.length, 5);
    const frameIds = files.map(file => Number(/(\d+)\.png$/.exec(file.name)?.[1])).sort((a, b) => a - b);
    assert.deepEqual(frameIds, [0, 1, 149, 150, 299]);
    for (const file of files) {
      const png = readFileSync(join(directory, file.name));
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1080, 1920]);
    }
  });
  const beforeFailure = new Set(readdirSync(outputRoot));
  const failure = run('invalid-frame', node, [npm, 'run', 'render:fixture', '--', '--format', 'portrait', '--frames', '300'], { fail: true });
  assert.match(failure, /frame[^\n]*(?:300|299|range|invalid)/i);
  inspectRun(beforeFailure, 'invalid-frame', (folder, receipt) => {
    assert.equal(receipt.status, 'failed');
    const videos = join(folder, 'videos');
    assert.ok(!existsSync(videos) || readdirSync(videos).length === 0, 'Rejected invocation left a video');
  });
  report.expectedFailure = 'frame 300 rejected';
}

try {
  await main();
  report.outcome = 'passed';
} catch (error) {
  report.outcome = phase === 'environment' || error.environment ? 'environment-failure' : 'code-failure';
  report.detail = error.message;
  process.exitCode = report.outcome === 'environment-failure' ? 11 : 10;
} finally {
  if (evidence) writeFileSync(join(evidence, 'host-verification.json'), JSON.stringify(report, null, 2));
}
