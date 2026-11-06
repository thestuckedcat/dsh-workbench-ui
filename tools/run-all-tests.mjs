#!/usr/bin/env node
// Run the complete plain-Node test suite with the pinned runtime and record
// evidence/tests.tap + evidence/test-summary.json.
//
// The two tests/host-rpc.test.mjs cases intentionally skip here: they run under
// the installed Electron embedded Node 24.21.0 via tools/test-rc5-host.mjs.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = join(ROOT, 'evidence');

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function main() {
  const tests = readdirSync(join(ROOT, 'tests')).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `tests/${name}`);
  mkdirSync(EVIDENCE, {recursive: true});
  const tapPath = join(EVIDENCE, 'tests.tap');
  const args = ['--test', '--test-concurrency=1', '--test-reporter=tap', `--test-reporter-destination=${tapPath}`, ...tests];
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = spawnSync(process.execPath, args, {cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true});
  const durationMs = Math.round(performance.now() - started);
  let tap = '';
  try {
    tap = readFileSync(tapPath, 'utf8');
  } catch {
    tap = '';
  }
  const summary = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = tap.match(new RegExp(`^# ${key} (\\d+)\\r?$`, 'm'));
    summary[key] = match === null ? null : Number(match[1]);
  }
  let lock = null;
  try {
    const lockText = readFileSync(join(ROOT, 'source-lock.json'), 'utf8');
    const parsed = JSON.parse(lockText);
    lock = {sha256: createHash('sha256').update(lockText).digest('hex'), host: parsed.host, runtime: parsed.runtime, artifacts: parsed.artifacts.length};
  } catch {
    lock = null;
  }
  const verified = result.status === 0 && summary.fail === 0 && summary.tests !== null && summary.tests === summary.pass + summary.skipped;
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    duration_ms: durationMs,
    runtime: {executable: process.execPath, node: process.versions.node, platform: process.platform, arch: process.arch},
    command: {executable: process.execPath, args},
    test_files: tests,
    exit_code: result.status,
    summary,
    verified,
    source_lock: lock,
    tap_sha256: tap === '' ? null : createHash('sha256').update(tap).digest('hex'),
    notes: [
      'tests/host-rpc.test.mjs skips under plain Node by design; it runs under the pinned Electron embedded Node 24.21.0 via tools/test-rc5-host.mjs (evidence/host-rc5/host24.json).',
      'Component tests use the pinned runtime and synthetic fixtures/adapters only; no user profile, credentials or network are touched.',
    ],
  };
  writeFileSync(join(EVIDENCE, 'test-summary.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.stdout.write(`${JSON.stringify({verified, exit_code: result.status, summary, duration_ms: durationMs}, null, 2)}\n`);
  process.exitCode = verified ? 0 : 1;
}

main();
