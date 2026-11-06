#!/usr/bin/env node
// Scratch profile recovery CLI (T3): run store.recover() and report the outcome.
//
// It refuses anything that is not a tool-created scratch root (the
// .workbench-profile marker is required), never creates a missing profile and
// never touches a real DSH profile. `--dry-run` reports what recovery would do
// without writing anything.
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MARKER_KIND, PROFILE_MARKER, STORE_SCHEMA_VERSION, createProfileStore} from '../src/profile-store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const RECOVERABLE_STATUSES = new Set(['active', 'restart_required', 'rolled_back']);

function diagnostic(code, severity, messageKey) {
  return {code, severity, module_ids: [], resource_ref: null, message_key: messageKey};
}

export function parseRestoreArgs(argv) {
  const options = {scratch: null, dryRun: false, profile: null};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--scratch') options.scratch = argv[++index];
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--profile') options.profile = argv[++index];
    else throw new Error(`unknown argument ${arg}`);
  }
  if (typeof options.scratch !== 'string' || options.scratch.trim() === '') throw new Error('--scratch <dir> is required');
  return options;
}

/** Verify the marker before adopting the directory; never create it here. */
function requireScratchMarker(scratchRoot) {
  const markerPath = join(scratchRoot, PROFILE_MARKER);
  let raw;
  try {
    raw = readFileSync(markerPath, 'utf8');
  } catch {
    throw new Error('scratch root has no .workbench-profile marker; refusing a non-scratch directory');
  }
  let marker;
  try {
    marker = JSON.parse(raw);
  } catch {
    throw new Error('scratch marker is unreadable');
  }
  if (marker === null || typeof marker !== 'object' || marker.schema_version !== STORE_SCHEMA_VERSION || marker.kind !== MARKER_KIND) {
    throw new Error('scratch marker was not created by this tool');
  }
}

/** Recover every profile below a scratch root (or one named profile). */
export function restoreScratch({scratch, dryRun = false, profile = null} = {}) {
  const report = {
    schema_version: STORE_SCHEMA_VERSION,
    ok: false,
    scratch: null,
    dry_run: dryRun === true,
    profiles: [],
    diagnostics: [],
  };
  let scratchRoot;
  try {
    scratchRoot = resolve(scratch);
    requireScratchMarker(scratchRoot);
  } catch (error) {
    report.diagnostics = [diagnostic('PATH_UNTRUSTED', 'error', 'restore.scratch_required')];
    return {exitCode: 2, report};
  }
  report.scratch = scratchRoot;

  let profileIds;
  try {
    const entries = readdirSync(join(scratchRoot, 'profiles'), {withFileTypes: true});
    profileIds = entries
      .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    report.diagnostics = [diagnostic('PROFILE_NOT_FOUND', 'error', 'restore.profiles_directory_missing')];
    return {exitCode: 2, report};
  }
  if (typeof profile === 'string' && profile !== '') {
    if (!profileIds.includes(profile)) {
      report.diagnostics = [diagnostic('PROFILE_NOT_FOUND', 'error', 'restore.profile_not_found')];
      return {exitCode: 2, report};
    }
    profileIds = [profile];
  }

  for (const profileId of profileIds) {
    try {
      const store = createProfileStore({root: scratchRoot, profile_id: profileId, allow_create: false});
      const recovery = store.recover({dry_run: dryRun === true});
      report.profiles.push({
        profile_id: profileId,
        status: recovery.status,
        revision: recovery.revision,
        previous_revision: recovery.previous_revision,
        composition_digest: recovery.composition_digest,
        recovered: recovery.recovered === true,
        dry_run: recovery.dry_run === true,
        actions: Array.isArray(recovery.actions) ? recovery.actions : [],
        diagnostics: Array.isArray(recovery.diagnostics) ? recovery.diagnostics : [],
      });
    } catch (error) {
      report.profiles.push({
        profile_id: profileId,
        status: 'denied',
        recovery_error: error?.code ?? 'INTERNAL_FAILURE',
      });
    }
  }

  report.ok = report.profiles.length > 0 && report.profiles.every((entry) => RECOVERABLE_STATUSES.has(entry.status));
  return {exitCode: report.ok ? 0 : 1, report};
}

function isMainModule() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  const self = fileURLToPath(import.meta.url);
  const left = resolve(entry);
  const right = resolve(self);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function main() {
  let options;
  try {
    options = parseRestoreArgs(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schema_version: STORE_SCHEMA_VERSION,
      ok: false,
      scratch: null,
      dry_run: false,
      profiles: [],
      diagnostics: [diagnostic('INVALID_REQUEST', 'error', 'restore.invalid_arguments')],
      message: String(error.message),
    }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  const {exitCode, report} = restoreScratch({scratch: options.scratch, dryRun: options.dryRun, profile: options.profile});
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = exitCode;
}

if (isMainModule()) main();
