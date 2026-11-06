#!/usr/bin/env node
// Isolated read-only doctor for the pinned rc.5 baseline (T1 / UI-01).
//
// Checks, in order: executable/archive digests, source-lock artifact bytes,
// pinned runtime version, and the reviewed client/Host seams re-read from the
// archive. It never loads a profile, never starts the Harness, never reads
// credentials and never touches the network.
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HOST_BASELINE} from '../src/contracts.mjs';
import {verifyHostDigests, verifyHostSeams, verifySourceLock} from '../src/compat.mjs';
import {readArchiveHeader, readEntry} from './host-rc5/asar.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = {
  archive: 'E:/dsh/resources/app.asar',
  executable: 'E:/dsh/DeepSeek Harness.exe',
};

function parseArgs(argv) {
  const options = {...DEFAULTS, isolated: false, host: null};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--isolated') options.isolated = true;
    else if (arg === '--host') options.host = argv[++index];
    else if (arg === '--archive') options.archive = argv[++index];
    else if (arg === '--executable') options.executable = argv[++index];
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    mode: options.isolated ? 'isolated-read-only' : 'read-only',
    host_requested: options.host,
    host: HOST_BASELINE,
    checks: {},
    limitations: [
      'Read-only archive/source checks; no profile loader, no client boot, no OS egress certification.',
      'Seam probes assert reviewed source facts, not that a live workbench renders.',
    ],
  };

  if (options.host !== null && options.host !== HOST_BASELINE.version) {
    report.checks.host_gate = {ok: false, expected: HOST_BASELINE.version, actual: options.host, status: 'needs_verification'};
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  report.checks.host_gate = {ok: true, expected: HOST_BASELINE.version, actual: options.host ?? HOST_BASELINE.version};

  report.checks.digests = verifyHostDigests({asarPath: options.archive, executablePath: options.executable});

  if (report.checks.digests.archive !== null) {
    const {header, dataOffset} = readArchiveHeader(options.archive);
    const readAsarFile = (path) => readEntry(options.archive, header, dataOffset, path);
    report.checks.seams = verifyHostSeams({readAsarFile});
  } else {
    report.checks.seams = {ok: false, failures: [{code: 'ARCHIVE_UNAVAILABLE'}]};
  }

  try {
    const lock = JSON.parse(readFileSync(resolve(ROOT, 'source-lock.json'), 'utf8'));
    report.checks.source_lock = verifySourceLock(lock, {root: ROOT});
    report.checks.runtime = {
      ok: process.versions.node === lock.runtime.version,
      expected: lock.runtime.version,
      actual: process.versions.node,
    };
  } catch (error) {
    report.checks.source_lock = {ok: false, failures: [{code: 'SOURCE_LOCK_UNREADABLE', detail: String(error.message ?? error)}]};
    report.checks.runtime = {ok: false, actual: process.versions.node};
  }

  const ok = Object.values(report.checks).every((check) => check.ok === true);
  report.ok = ok;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

main();
