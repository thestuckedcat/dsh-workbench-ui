#!/usr/bin/env node
// Run the real-rc.5 Host-runtime test under the installed Electron's embedded
// Node 24.21.0 (asar-aware) with an isolated DSH_HOME. The parent process first
// verifies the pinned executable/archive digests, then runs the TAP test and
// records the layered evidence JSON.
//
// This runner proves: real Cordis version/lifecycle + our host plugin mounted
// and disposed. It does not boot the profile loader or render the client half.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HOST_BASELINE} from '../src/contracts.mjs';
import {validateSourceLock} from '../src/compat.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTABLE = 'E:/dsh/DeepSeek Harness.exe';
const ARCHIVE = 'E:/dsh/resources/app.asar';
const HOST_ROOT = 'E:/dsh/resources/app.asar/dsh';

function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function main() {
  const executableSha = sha(EXECUTABLE);
  const archiveSha = sha(ARCHIVE);
  const evidenceDir = resolve(ROOT, 'evidence/host-rc5');
  mkdirSync(evidenceDir, {recursive: true});
  const isolatedHome = resolve(ROOT, 'scratch/host24-home');
  mkdirSync(isolatedHome, {recursive: true});

  const tapPath = resolve(evidenceDir, 'host24.tap');
  const args = ['--test', '--test-concurrency=1', '--test-reporter=tap', `--test-reporter-destination=${tapPath}`, 'tests/host-rpc.test.mjs'];
  const env = {
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: isolatedHome,
    DSH_AUDIT_APP_ROOT: HOST_ROOT,
    DSH_TELEMETRY_DISABLED: '1',
  };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = spawnSync(EXECUTABLE, args, {cwd: ROOT, windowsHide: true, encoding: 'utf8', timeout: 120000, env});
  const durationMs = Math.round(performance.now() - started);
  let tapText = '';
  try {
    tapText = readFileSync(tapPath, 'utf8');
  } catch {
    tapText = '';
  }
  const summary = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = tapText.match(new RegExp(`^# ${key} (\\d+)\\r?$`, 'm'));
    summary[key] = match === null ? null : Number(match[1]);
  }
  const lock = JSON.parse(readFileSync(resolve(ROOT, 'source-lock.json'), 'utf8'));
  validateSourceLock(lock);
  const hostMatches = executableSha === HOST_BASELINE.executable_sha256 && archiveSha === HOST_BASELINE.app_asar_sha256;
  const artifacts = ['bundle/index.js', 'src/host-rc5.mjs', 'src/rpc.mjs', 'src/access.mjs', 'src/registry.mjs', 'src/actions.mjs', 'tests/host-rpc.test.mjs', 'tools/test-rc5-host.mjs'];
  const verified = result.status === 0 && hostMatches && summary.fail === 0 && summary.tests !== null && summary.tests === summary.pass;
  const report = {
    schema_version: 1,
    date: '2026-11-07',
    started_at_utc: startedAt,
    duration_ms: durationMs,
    purpose: 'Real pinned rc.5 Context mounts/serves/disposes the workbench host plugin with a synthetic local connection double',
    host: HOST_BASELINE,
    executable: {path: EXECUTABLE, sha256: executableSha},
    archive: {path: ARCHIVE, sha256: archiveSha},
    runtime: {node: HOST_BASELINE.embedded_node, electron: HOST_BASELINE.electron, parent_node: process.versions.node},
    command: {executable: EXECUTABLE, args},
    isolated_home: isolatedHome,
    artifacts: artifacts.map((path) => ({path, sha256: sha(resolve(ROOT, path))})),
    source_lock_sha256: sha(resolve(ROOT, 'source-lock.json')),
    exit_code: result.status,
    tap_summary: summary,
    tap_sha256: tapText === '' ? null : createHash('sha256').update(tapText).digest('hex'),
    verified,
    layering: {
      static_contracts: true,
      component_tests: true,
      real_pinned_host_runtime: verified,
      full_profile_loader: false,
      client_browser_render: false,
      os_egress_certification: false,
    },
    limitations: [
      'Uses a synthetic local connection service double; the real browser peer/transport is not exercised here.',
      'No profile bundle install and no client browser boot; the UI render acceptance remains pending.',
      'The embedded Node reports the real rc.5 Cordis version; a full profile-loaded runtime is still a separate layer.',
    ],
  };
  writeFileSync(resolve(evidenceDir, 'host24.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.stdout.write(`${JSON.stringify({verified, exit_code: result.status, tap_summary: summary, duration_ms: durationMs}, null, 2)}\n`);
  process.exitCode = verified ? 0 : 1;
}

main();
