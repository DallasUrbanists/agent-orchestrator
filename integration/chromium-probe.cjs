const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const { dirname, join, relative } = require('node:path');
const { once } = require('node:events');

const report = {};

async function runWithFileOutput(executable, args, name, timeout) {
  const output = join(report.scratch, name + '.stdout');
  const diagnostic = join(report.scratch, name + '.stderr');
  const stdout = openSync(output, 'wx');
  try {
    const stderr = openSync(diagnostic, 'wx');
    try {
      const child = spawn(executable, args, {
        stdio: ['ignore', stdout, stderr], windowsHide: true, signal: AbortSignal.timeout(timeout)
      });
      const [code] = await once(child, 'close');
      if (code !== 0) {
        const error = new Error(name + ' exited with code ' + code);
        error.code = code;
        error.stderr = readFileSync(diagnostic, 'utf8');
        throw error;
      }
      return readFileSync(output, 'utf8');
    } finally { closeSync(stderr); }
  } finally { closeSync(stdout); }
}
async function main() {
  const scratch = realpathSync(process.env.ORCHESTRATOR_WORKER_TEMP);
  assert.equal(relative(realpathSync(process.cwd()), dirname(scratch)), '');
  process.env.TEMP = scratch;
  process.env.TMP = scratch;
  process.env.TMPDIR = scratch;
  report.scratch = realpathSync(tmpdir());
  assert.equal(relative(realpathSync(process.cwd()), dirname(report.scratch)), '');
  writeFileSync(join(report.scratch, 'writable.txt'), 'worker scratch');
  try {
    await runWithFileOutput(process.execPath, ['--version'], 'node', 5000);
    report.nodeSubprocess = 'passed';
  } catch (error) {
    report.nodeSubprocess = error.code ?? 'failed';
  }

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<title>worker browser fixture</title><p>orchestrator-loopback-ok</p>');
  });
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const profile = mkdtempSync(join(report.scratch, 'chromium-'));
    report.profileCreated = true;
    const stdout = await runWithFileOutput(process.argv[2], [
      '--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run',
      '--user-data-dir=' + profile, '--dump-dom', 'http://127.0.0.1:' + server.address().port
    ], 'chromium', 30000);
    assert.match(stdout, /<p>orchestrator-loopback-ok<\/p>/);
    report.browser = 'passed';
  } finally {
    server.close();
  }
}

main().catch(error => {
  report.browser = error.code ?? 'failed';
  report.detail = error.stderr?.slice(-2000) || error.message;
  process.exitCode = 1;
}).finally(() => {
  writeFileSync('chromium-result.json', JSON.stringify(report, null, 2));
  if (report.nodeSubprocess !== 'passed') process.exitCode = 1;
});
