#!/usr/bin/env node
// Generate or verify source-lock v1 for the workbench code artifacts.
//
// The lock pins the reviewed bytes of every runtime artifact plus the vendored
// semver package and the selected-module catalog. `--write` regenerates the
// artifact rows (reviewed code only; tests and docs are evidence, not runtime
// artifacts); the default mode verifies the checked-in lock and never writes.
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HOST_BASELINE} from '../src/contracts.mjs';
import {validateSourceLock as validateLock, verifySourceLock} from '../src/compat.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = '@local/dsh-workbench-ui';
const SELF_VERSION = '0.1.0-dev.1';
const TEST_RUNTIME = {version: '26.13.0'};
const SEMVER = {package: 'semver', version: '7.8.6', license: 'ISC', license_ref: 'vendor/semver/LICENSE', source_ref: 'npm-registry/semver/7.8.6'};

const INCLUDE_DIRS = ['src', 'bundle', 'tools', 'vendor/semver', 'profile'];
const EXCLUDE = new Set(['source-lock.json']);
const TEXT_EXTENSIONS = ['.mjs', '.cjs', '.js', '.json', '.yml', '.yaml', '.ts', '.tsx', '.css', '.md'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name === 'node_modules' || name === '.git' || name === 'scratch') continue;
      walk(full, out);
    } else if (stat.isFile() && !EXCLUDE.has(relative(ROOT, full)) && TEXT_EXTENSIONS.some((extension) => name.endsWith(extension))) {
      out.push(full);
    }
  }
  return out;
}

function rows() {
  const artifacts = [];
  for (const dir of INCLUDE_DIRS) {
    const fullDir = join(ROOT, dir);
    let files;
    try {
      files = statSync(fullDir).isDirectory() ? walk(fullDir) : [fullDir];
    } catch {
      continue;
    }
    for (const full of files) filesystemRow(artifacts, full);
  }
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  return artifacts;
}

function filesystemRow(artifacts, full) {
  const relativePath = relative(ROOT, full).split(sep).join('/');
  if (artifacts.some((row) => row.path === relativePath)) return;
  const bytes = readFileSync(full);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const isVendor = relativePath.startsWith('vendor/semver/');
  const idBase = relativePath
    .replace(/\.[a-z]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const artifact = {
    id: isVendor ? `vendor-${idBase.replace(/^vendor-semver-/, 'semver-')}` : idBase,
    path: relativePath,
    sha256,
    size: bytes.length,
    package: isVendor ? SEMVER.package : SELF,
    version: isVendor ? SEMVER.version : SELF_VERSION,
    license: isVendor ? SEMVER.license : 'UNLICENSED',
    license_ref: isVendor ? SEMVER.license_ref : 'README.md',
    source_ref: isVendor ? SEMVER.source_ref : `workspace/${relativePath}`,
  };
  if (artifacts.some((row) => row.id === artifact.id)) throw new Error(`duplicate artifact id ${artifact.id}`);
  artifacts.push(artifact);
}

function runtimeInfo() {
  const runtimePath = 'runtime/node.exe';
  const bytes = readFileSync(join(ROOT, runtimePath));
  return {path: runtimePath, version: TEST_RUNTIME.version, sha256: createHash('sha256').update(bytes).digest('hex')};
}

function build() {
  return {
    schema_version: 1,
    host: {
      version: HOST_BASELINE.version,
      exe_sha256: HOST_BASELINE.executable_sha256,
      asar_sha256: HOST_BASELINE.app_asar_sha256,
      runtime: {executable: 'runtime/electron-run-as-node', version: HOST_BASELINE.embedded_node, sha256: HOST_BASELINE.executable_sha256},
    },
    runtime: runtimeInfo(),
    artifacts: rows(),
    selected_modules: [],
    evidence_refs: ['evidence/host-rc5/source-manifest.json', 'evidence/verification.json'],
  };
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const lockPath = join(ROOT, 'source-lock.json');
  if (write) {
    const lock = build();
    validateLock(lock);
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    process.stdout.write(`wrote ${relative(ROOT, lockPath)} with ${lock.artifacts.length} artifacts\n`);
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  validateLock(lock);
  const report = verifySourceLock(lock, {root: ROOT});
  process.stdout.write(`${JSON.stringify({schema_version: 1, mode: write ? 'write' : 'check', ok: report.ok, artifacts: lock.artifacts.length, failures: report.failures}, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) main();
