// Scratch-only profile transaction store (T3 / UI-03).
//
// The store owns exactly one profile directory tree:
//
//   <root>/.workbench-profile                     (tool-created marker, never reused by guess)
//   <root>/profiles/<profile_id>/current.json    (atomic pointer to the active revision)
//   <root>/profiles/<profile_id>/revisions/<n>/  (immutable sealed revision: profile.json + cordis.patch.yml)
//   <root>/profiles/<profile_id>/journal/<op>.json
//   <root>/profiles/<profile_id>/lock.json       (single-writer lock, wx-created)
//
// It refuses untrusted roots (relative, parent traversal, UNC/network, symlink
// or reparse components), refuses to adopt a pre-existing non-empty directory,
// never touches a real DSH profile, and never claims a composition is active
// without an injected verification verdict or explicit local evidence.
import {createHash, randomUUID} from 'node:crypto';
import * as nodeFs from 'node:fs';
import {dirname, isAbsolute, join, normalize, parse, resolve} from 'node:path';
import {
  HOST_BASELINE,
  LIMITS,
  ContractError,
  PREFERRED_ORDER,
  digestOf,
  isPlainObject,
  validateProfileV1,
} from './contracts.mjs';
import {assertModuleId, assertStableId} from './contracts.mjs';
import {finalizeDiagnostics, makeDiagnostic} from './conflicts.mjs';
import {compositionDigest, resolveComposition} from './resolve.mjs';
import {
  COMPOSE_PHASES,
  FAILURE_PHASES,
  applyComposition,
  describeJournalOutcome,
  isTerminalPhase,
  isUnresolvedPhase,
  recoverComposition,
} from './compose.mjs';

export const PROFILE_MARKER = '.workbench-profile';
export const MARKER_KIND = 'workbench-scratch-profile';
export const STORE_SCHEMA_VERSION = 1;
export const PREVIEW_TTL_MS = 10 * 60 * 1000;
export const POLICY_REF = 'policy/scratch-v1';

/**
 * Process identity recorded in the single-writer lock. On Windows a reused pid
 * cannot be distinguished from the original owner, so a live pid always means
 * "busy"; there is no start-time probe without native code. The token exists so
 * this process can prove a lock is its own when releasing.
 */
export const PROCESS_START_TOKEN = `${process.pid}:${process.hrtime.bigint()}`;

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const STAGING_NAME = /^\.[A-Za-z0-9._-]{1,80}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const CURRENT_STATUSES = new Set(['active', 'restart_required', 'switching']);
const JOURNAL_PHASES = new Set([...COMPOSE_PHASES, 'switched', 'restart_required', ...FAILURE_PHASES, 'no_change', 'recovered']);
const PREFERRED_INDEX = new Map(PREFERRED_ORDER.map((id, index) => [id, index]));

const EMPTY_COMPOSITION_DIGEST = compositionDigest(HOST_BASELINE.version, []);

export class ProfileStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProfileStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProfileStoreError(code, message);
}

// ---------------------------------------------------------------------------
// Diagnostics helpers (apply results are plain data, validated by contract)
// ---------------------------------------------------------------------------

function storeDiagnostic(code, severity, messageKey, moduleIds = []) {
  return makeDiagnostic({code, severity, module_ids: moduleIds, resource_ref: null, message_key: messageKey});
}

function result(status, snapshot, diagnostics, extra = {}) {
  return {
    status,
    revision: snapshot?.revision ?? null,
    previous_revision: snapshot?.revision ?? null,
    composition_digest: snapshot?.composition_digest ?? null,
    diagnostics: finalizeDiagnostics(diagnostics),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Time helpers (injectable clock for TTL / createdAt tests)
// ---------------------------------------------------------------------------

function nowMs(clock) {
  const value = clock();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  fail('INVALID_INPUT', 'now() must return epoch milliseconds or a Date');
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Trusted-path gate
// ---------------------------------------------------------------------------

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** Absolute local path only: no `..`, no UNC/network/device prefix. */
export function assertLocalAbsolutePath(value, label = 'root') {
  if (typeof value !== 'string' || value.trim() === '') fail('PATH_UNTRUSTED', `${label} must be a non-empty string`);
  if (value.includes('\u0000')) fail('PATH_UNTRUSTED', `${label} must not contain NUL bytes`);
  if (!isAbsolute(value)) fail('PATH_UNTRUSTED', `${label} must be an absolute local path`);
  if (value.split(/[\\/]+/).includes('..')) fail('PATH_UNTRUSTED', `${label} must not contain parent traversal`);
  if (process.platform === 'win32') {
    if (/^[\\/]{2}/.test(value)) fail('PATH_UNTRUSTED', 'UNC/network/device paths are rejected');
    if (!/^[A-Za-z]:[\\/]/.test(value)) fail('PATH_UNTRUSTED', `${label} must be a local drive path like E:\\scratch`);
    if (/^[A-Za-z]:[\\/]*$/.test(value)) fail('PATH_UNTRUSTED', `${label} must not be a drive root`);
  } else if (value.startsWith('//')) {
    fail('PATH_UNTRUSTED', 'network paths are rejected');
  }
  return normalize(value);
}

/**
 * Walk every existing component of the path and reject symlinks/junctions or
 * any component whose real path differs from its lexical identity. String
 * prefix checks alone are not trusted here.
 */
export function assertPathChainLocal(f, targetPath) {
  const resolved = resolve(targetPath);
  const {root: volumeRoot} = parse(resolved);
  const remainder = resolved.slice(volumeRoot.length);
  const segments = remainder.split(/[\\/]+/).filter(Boolean);
  const chain = [volumeRoot];
  let current = volumeRoot;
  for (const segment of segments) {
    current = join(current, segment);
    chain.push(current);
  }
  for (const prefix of chain) {
    let stat;
    try {
      stat = f.lstatSync(prefix);
    } catch (error) {
      if (error && error.code === 'ENOENT') return; // remaining components will be created by this store
      throw error;
    }
    if (stat.isSymbolicLink()) fail('PATH_UNTRUSTED', `symbolic link/reparse point in path: ${prefix}`);
    let real = null;
    try {
      real = typeof f.realpathSync?.native === 'function' ? f.realpathSync.native(prefix) : f.realpathSync(prefix);
    } catch {
      real = null;
    }
    if (real !== null && !samePath(real, prefix)) fail('PATH_UNTRUSTED', `path component resolves elsewhere: ${prefix}`);
  }
}

// ---------------------------------------------------------------------------
// Durable filesystem helpers
// ---------------------------------------------------------------------------

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fileExists(f, path) {
  try {
    f.lstatSync(path);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function writeFileDurable(f, path, bytes) {
  f.writeFileSync(path, bytes, {mode: 0o600});
  const fd = f.openSync(path, 'r+');
  try {
    f.fsyncSync(fd);
  } finally {
    f.closeSync(fd);
  }
}

function fsyncDir(f, path) {
  let fd = null;
  try {
    fd = f.openSync(path, 'r');
    f.fsyncSync(fd);
  } catch {
    // Directory fsync is not supported on Windows; file fsync + rename ordering
    // is what the platform provides. Documented limitation, not a silent claim.
  } finally {
    if (fd !== null) {
      try {
        f.closeSync(fd);
      } catch {
        // best effort
      }
    }
  }
}

let atomicCounter = 0;

function atomicWrite(f, destination, bytes) {
  atomicCounter += 1;
  const temporary = `${destination}.tmp-${process.pid}-${atomicCounter}`;
  writeFileDurable(f, temporary, bytes);
  try {
    f.renameSync(temporary, destination);
  } catch (error) {
    try {
      f.unlinkSync(temporary);
    } catch {
      // best effort
    }
    throw error;
  }
  fsyncDir(f, dirname(destination));
}

// ---------------------------------------------------------------------------
// Pointer / journal validation
// ---------------------------------------------------------------------------

const CURRENT_KEYS = Object.freeze([
  'schema_version', 'profile_id', 'revision', 'composition_digest', 'policy_digest',
  'status', 'verified', 'operation_id', 'updated_at', 'verified_at',
]);

function corrupt(message) {
  throw new ProfileStoreError('JOURNAL_CORRUPT', message);
}

function validateCurrentPointer(value, profileId, label = 'current') {
  if (!isPlainObject(value)) corrupt(`${label} must be a plain object`);
  for (const key of Object.keys(value)) {
    if (!CURRENT_KEYS.includes(key)) corrupt(`${label} has an unknown field: ${key}`);
  }
  for (const required of ['schema_version', 'profile_id', 'revision', 'composition_digest', 'status', 'verified', 'operation_id', 'updated_at']) {
    if (!(required in value)) corrupt(`${label}.${required} is missing`);
  }
  if (value.schema_version !== STORE_SCHEMA_VERSION) corrupt(`${label}.schema_version must be ${STORE_SCHEMA_VERSION}`);
  if (value.profile_id !== profileId) corrupt(`${label}.profile_id does not match this store`);
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) corrupt(`${label}.revision must be a non-negative integer`);
  if (typeof value.composition_digest !== 'string' || !SHA256.test(value.composition_digest)) corrupt(`${label}.composition_digest must be a sha256`);
  if (value.policy_digest !== null && value.policy_digest !== undefined && (typeof value.policy_digest !== 'string' || !SHA256.test(value.policy_digest))) {
    corrupt(`${label}.policy_digest must be null or a sha256`);
  }
  if (!CURRENT_STATUSES.has(value.status)) corrupt(`${label}.status is not a known pointer status`);
  if (typeof value.verified !== 'boolean') corrupt(`${label}.verified must be a boolean`);
  if (value.operation_id !== null && (typeof value.operation_id !== 'string' || !OPERATION_ID.test(value.operation_id))) corrupt(`${label}.operation_id is invalid`);
  if (typeof value.updated_at !== 'string' || !ISO_TIME.test(value.updated_at)) corrupt(`${label}.updated_at must be an ISO timestamp`);
  if (value.verified_at !== undefined && value.verified_at !== null && (typeof value.verified_at !== 'string' || !ISO_TIME.test(value.verified_at))) {
    corrupt(`${label}.verified_at must be null or an ISO timestamp`);
  }
  return value;
}

const JOURNAL_KEYS = Object.freeze([
  'schema_version', 'profile_id', 'operation_id', 'preview_id', 'phase', 'revision',
  'previous_revision', 'previous_current', 'previous_composition_digest',
  'previous_profile_sha256', 'new_composition_digest', 'policy_digest', 'selected_ids',
  'staged_name', 'reason_code', 'created_at', 'updated_at', 'finalized_at',
]);

function validateJournalEntry(value, profileId) {
  if (!isPlainObject(value)) corrupt('journal entry must be a plain object');
  for (const key of Object.keys(value)) {
    if (!JOURNAL_KEYS.includes(key)) corrupt(`journal entry has an unknown field: ${key}`);
  }
  for (const required of ['schema_version', 'profile_id', 'operation_id', 'phase', 'revision', 'previous_revision',
    'previous_current', 'previous_composition_digest', 'new_composition_digest', 'policy_digest', 'selected_ids', 'created_at', 'updated_at']) {
    if (!(required in value)) corrupt(`journal entry.${required} is missing`);
  }
  if (value.schema_version !== STORE_SCHEMA_VERSION) corrupt('journal entry.schema_version mismatch');
  if (value.profile_id !== profileId) corrupt('journal entry belongs to another profile');
  if (typeof value.operation_id !== 'string' || !OPERATION_ID.test(value.operation_id)) corrupt('journal entry.operation_id is invalid');
  if (!JOURNAL_PHASES.has(value.phase)) corrupt('journal entry.phase is unknown');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) corrupt('journal entry.revision is invalid');
  if (!Number.isSafeInteger(value.previous_revision) || value.previous_revision < 0) corrupt('journal entry.previous_revision is invalid');
  validateCurrentPointer(value.previous_current, profileId, 'journal.previous_current');
  if (typeof value.previous_composition_digest !== 'string' || !SHA256.test(value.previous_composition_digest)) corrupt('journal entry.previous_composition_digest is invalid');
  if (typeof value.new_composition_digest !== 'string' || !SHA256.test(value.new_composition_digest)) corrupt('journal entry.new_composition_digest is invalid');
  if (typeof value.policy_digest !== 'string' || !SHA256.test(value.policy_digest)) corrupt('journal entry.policy_digest is invalid');
  if (!Array.isArray(value.selected_ids) || value.selected_ids.length > LIMITS.max_manifests) corrupt('journal entry.selected_ids is invalid');
  for (const id of value.selected_ids) assertModuleId(id, 'journal.selected_ids');
  if (value.previous_profile_sha256 !== undefined && value.previous_profile_sha256 !== null
    && (typeof value.previous_profile_sha256 !== 'string' || !SHA256.test(value.previous_profile_sha256))) {
    corrupt('journal entry.previous_profile_sha256 is invalid');
  }
  if (value.staged_name !== undefined && value.staged_name !== null && (typeof value.staged_name !== 'string' || !STAGING_NAME.test(value.staged_name))) {
    corrupt('journal entry.staged_name is invalid');
  }
  if (value.reason_code !== undefined && value.reason_code !== null && (typeof value.reason_code !== 'string' || value.reason_code.length > 64)) {
    corrupt('journal entry.reason_code is invalid');
  }
  if (value.preview_id !== undefined && value.preview_id !== null && (typeof value.preview_id !== 'string' || value.preview_id.length > 128)) {
    corrupt('journal entry.preview_id is invalid');
  }
  for (const timeKey of ['created_at', 'updated_at', 'finalized_at']) {
    if (value[timeKey] !== undefined && (typeof value[timeKey] !== 'string' || !ISO_TIME.test(value[timeKey]))) corrupt(`journal entry.${timeKey} is invalid`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Diff report (used by prepare previews and by conflict diagnostics)
// ---------------------------------------------------------------------------

function refsOf(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.module_refs)) {
    return value.module_refs
      .filter((ref) => isPlainObject(ref) && typeof ref.id === 'string' && /^0[1-8]$/.test(ref.id))
      .map((ref) => ({id: ref.id, sha256: typeof ref.sha256 === 'string' ? ref.sha256 : null}));
  }
  if (Array.isArray(value.ordered)) {
    return value.ordered
      .filter((id) => typeof id === 'string' && /^0[1-8]$/.test(id))
      .map((id) => ({id, sha256: null}));
  }
  return [];
}

function sortByPreference(ids) {
  return [...ids].sort((left, right) => {
    const leftIndex = PREFERRED_INDEX.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = PREFERRED_INDEX.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * Add/remove/change diff between the current profile (ProfileV1, pointer or
 * null) and the next one (ProfileV1-like or a validated resolve result). When
 * digests are not available on one side the entry is listed under `unchanged`
 * with `comparable: false` instead of guessing a change.
 */
export function diffBetween(previous, next) {
  const fromRefs = refsOf(previous);
  const toRefs = refsOf(next);
  const fromMap = new Map(fromRefs.map((ref) => [ref.id, ref]));
  const toMap = new Map(toRefs.map((ref) => [ref.id, ref]));
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  for (const id of sortByPreference([...toMap.keys()])) {
    if (!fromMap.has(id)) {
      added.push(id);
      continue;
    }
    const from = fromMap.get(id);
    const to = toMap.get(id);
    if (from.sha256 && to.sha256 && from.sha256 !== to.sha256) {
      changed.push({id, from_sha256: from.sha256, to_sha256: to.sha256});
    } else {
      unchanged.push(id);
    }
  }
  for (const id of sortByPreference([...fromMap.keys()])) {
    if (!toMap.has(id)) removed.push(id);
  }
  return {
    from_revision: previous?.revision ?? null,
    to_revision: next?.revision ?? null,
    added,
    removed,
    changed,
    unchanged,
    from_composition_digest: previous?.composition_digest ?? null,
    to_composition_digest: next?.composition_digest ?? null,
  };
}

// ---------------------------------------------------------------------------
// Deterministic fixture patch projection
// ---------------------------------------------------------------------------

function renderPatch({profile, modules}) {
  const lines = [];
  lines.push('# SCRATCH FIXTURE COMPOSITION -- generated by 08-workbench-ui profile store.');
  lines.push('# This sealed revision record is NOT a loadable Cordis patch and claims no Host load.');
  lines.push('# Real loader patches are generated only for verified module releases (implementation-route T5).');
  lines.push('schema_version: 1');
  lines.push(`profile_id: ${profile.profile_id}`);
  lines.push(`revision: ${profile.revision}`);
  lines.push(`host_version: ${profile.host_version}`);
  lines.push(`composition_digest: ${profile.composition_digest}`);
  lines.push('modules:');
  for (const module of modules) {
    lines.push(`  - id: ${JSON.stringify(module.id)}`);
    lines.push(`    name: ${JSON.stringify(module.name)}`);
    lines.push(`    artifact_ref: ${module.artifact_ref}`);
    lines.push(`    sha256: ${module.sha256}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Create (or reopen) a scratch profile store.
 *
 * @param {object} options
 * @param {string} options.root absolute local scratch root, e.g. E:\\scratch\\compose-smoke
 * @param {string} options.profile_id stable profile id (also the directory name)
 * @param {() => number|Date} [options.now] injectable clock (preview TTL / timestamps)
 * @param {object} [options.fs] partial node:fs adapter override (write-failure injection)
 * @param {boolean} [options.allow_create] false = read-only existing store (restore tool)
 */
export function createProfileStore(options = {}) {
  if (!isPlainObject(options)) fail('INVALID_INPUT', 'createProfileStore options must be a plain object');
  const {root, profile_id: profileId, now} = options;
  const allowCreate = options.allow_create !== false;
  if (typeof profileId !== 'string' || profileId === '') fail('INVALID_INPUT', 'profile_id is required');
  assertStableId(profileId, 'profile_id');
  const rootPath = assertLocalAbsolutePath(root, 'root');
  const clock = typeof now === 'function' ? now : () => Date.now();
  const f = Object.assign({}, nodeFs, isPlainObject(options.fs) ? options.fs : {});

  assertPathChainLocal(f, rootPath);
  const rootInfo = ensureRoot(f, {rootPath, allowCreate, clock});
  const profileDir = join(rootPath, 'profiles', profileId);
  assertPathChainLocal(f, profileDir);
  ensureOwnedDir(f, profileDir, allowCreate);
  const revisionsDir = join(profileDir, 'revisions');
  const journalDir = join(profileDir, 'journal');
  ensureOwnedDir(f, revisionsDir, allowCreate);
  ensureOwnedDir(f, journalDir, allowCreate);
  assertPathChainLocal(f, profileDir);
  const currentPath = join(profileDir, 'current.json');
  const lockPath = join(profileDir, 'lock.json');

  const nowIso = () => iso(nowMs(clock));

  // Initial state: revision 0 is the empty composition (nothing to load, so it
  // is trivially consistent). A store with sealed revisions but no pointer is
  // corrupt and is never silently reset.
  if (!fileExists(f, currentPath)) {
    if (!allowCreate) fail('PROFILE_NOT_FOUND', 'current.json is missing; refusing to initialize a non-scratch profile');
    let revisionNames = [];
    try {
      revisionNames = f.readdirSync(revisionsDir).filter((name) => /^\d+$/.test(name));
    } catch {
      revisionNames = [];
    }
    if (revisionNames.length > 0) fail('JOURNAL_CORRUPT', 'sealed revisions exist but current.json is missing');
    atomicWrite(f, currentPath, serialize({
      schema_version: STORE_SCHEMA_VERSION,
      profile_id: profileId,
      revision: 0,
      composition_digest: EMPTY_COMPOSITION_DIGEST,
      policy_digest: null,
      status: 'active',
      verified: true,
      operation_id: null,
      updated_at: nowIso(),
      verified_at: null,
    }));
  }

  function revisionDirPath(revision) {
    if (!Number.isSafeInteger(revision) || revision < 1) fail('INVALID_INPUT', 'revision must be a positive integer');
    return join(revisionsDir, String(revision));
  }

  function readRevisionProfile(revision) {
    const dir = revisionDirPath(revision);
    let profileRaw;
    try {
      profileRaw = f.readFileSync(join(dir, 'profile.json'));
    } catch {
      fail('PROFILE_NOT_FOUND', `revision ${revision} profile.json is unreadable`);
    }
    let parsed;
    try {
      parsed = JSON.parse(profileRaw.toString('utf8'));
    } catch {
      fail('JOURNAL_CORRUPT', `revision ${revision} profile.json is not valid JSON`);
    }
    let profile;
    try {
      profile = validateProfileV1(parsed, `revision[${revision}].profile`);
    } catch (error) {
      const detail = error instanceof ContractError ? error.message : 'invalid profile';
      fail('JOURNAL_CORRUPT', `revision ${revision} profile.json is invalid: ${detail}`);
    }
    if (profile.revision !== revision) fail('JOURNAL_CORRUPT', `revision ${revision} profile.json declares revision ${profile.revision}`);
    let patchRaw;
    try {
      patchRaw = f.readFileSync(join(dir, 'cordis.patch.yml'));
    } catch {
      fail('JOURNAL_CORRUPT', `revision ${revision} cordis.patch.yml is unreadable`);
    }
    return {
      revision,
      profile,
      profile_sha256: createHash('sha256').update(profileRaw).digest('hex'),
      patch_sha256: createHash('sha256').update(patchRaw).digest('hex'),
    };
  }

  function loadCurrent() {
    let raw;
    try {
      raw = f.readFileSync(currentPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') fail('PROFILE_NOT_FOUND', 'current.json is missing');
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      corrupt('current.json is not valid JSON');
    }
    return validateCurrentPointer(parsed, profileId, 'current');
  }

  function listRevisions() {
    let names;
    try {
      names = f.readdirSync(revisionsDir);
    } catch {
      fail('PROFILE_NOT_FOUND', 'revisions directory is unreadable');
    }
    const revisions = [];
    for (const name of names.sort()) {
      if (!/^\d+$/.test(name)) continue;
      const revision = Number(name);
      try {
        const stored = readRevisionProfile(revision);
        revisions.push({
          revision,
          composition_digest: stored.profile.composition_digest,
          profile_sha256: stored.profile_sha256,
          patch_sha256: stored.patch_sha256,
          module_ids: stored.profile.module_refs.map((ref) => ref.id),
        });
      } catch (error) {
        revisions.push({revision, corrupt: true, error_code: error?.code ?? 'JOURNAL_CORRUPT'});
      }
    }
    return revisions.sort((left, right) => left.revision - right.revision);
  }

  function readJournalTolerant() {
    let names;
    try {
      names = f.readdirSync(journalDir);
    } catch {
      fail('JOURNAL_CORRUPT', 'journal directory is unreadable');
    }
    const entries = [];
    const corruptEntries = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const operationId = name.slice(0, -'.json'.length);
      let raw;
      try {
        raw = f.readFileSync(join(journalDir, name), 'utf8');
      } catch {
        corruptEntries.push({operation_id: operationId, code: 'JOURNAL_UNREADABLE'});
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        corruptEntries.push({operation_id: operationId, code: 'JOURNAL_CORRUPT'});
        continue;
      }
      try {
        entries.push(validateJournalEntry(parsed, profileId));
      } catch {
        corruptEntries.push({operation_id: operationId, code: 'JOURNAL_CORRUPT'});
      }
    }
    return {entries, corrupt: corruptEntries};
  }

  function readJournalEntry(operationId) {
    if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) fail('INVALID_INPUT', 'operation_id is invalid');
    let raw;
    try {
      raw = f.readFileSync(join(journalDir, `${operationId}.json`), 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      corrupt(`journal ${operationId} is not valid JSON`);
    }
    return validateJournalEntry(parsed, profileId);
  }

  function writeCurrent(pointer) {
    const validated = validateCurrentPointer(pointer, profileId, 'current');
    atomicWrite(f, currentPath, serialize(validated));
  }

  function restoreCurrent(snapshot) {
    try {
      if (!isPlainObject(snapshot)) return {ok: false, reason: 'invalid_snapshot'};
      const candidate = {...snapshot, updated_at: nowIso()};
      writeCurrent(candidate);
      return {ok: true};
    } catch {
      return {ok: false, reason: 'write_failed'};
    }
  }

  function writeJournal(entry) {
    if (!isPlainObject(entry)) fail('INVALID_INPUT', 'journal entry must be a plain object');
    if (typeof entry.operation_id !== 'string' || !OPERATION_ID.test(entry.operation_id)) fail('INVALID_INPUT', 'journal operation_id is invalid');
    const validated = validateJournalEntry(entry, profileId);
    atomicWrite(f, join(journalDir, `${validated.operation_id}.json`), serialize(validated));
  }

  function stageRevision(profile, patchText, operationId) {
    const stagingName = `.staging-${operationId}-${randomUUID().slice(0, 8)}`;
    if (!STAGING_NAME.test(stagingName)) fail('INVALID_INPUT', 'staging name is invalid');
    const stagedDir = join(revisionsDir, stagingName);
    try {
      f.mkdirSync(stagedDir);
      writeFileDurable(f, join(stagedDir, 'profile.json'), serialize(profile));
      writeFileDurable(f, join(stagedDir, 'cordis.patch.yml'), String(patchText));
      fsyncDir(f, stagedDir);
    } catch (error) {
      try {
        f.rmSync(stagedDir, {recursive: true, force: true});
      } catch {
        // best effort
      }
      fail('WRITE_FAILED', `failed to write staged revision: ${error?.code ?? 'unknown'}`);
    }
    return stagingName;
  }

  function commitRevision(stagingName, revision) {
    if (typeof stagingName !== 'string' || !STAGING_NAME.test(stagingName)) fail('INVALID_INPUT', 'staging name is invalid');
    const target = revisionDirPath(revision);
    if (fileExists(f, target)) fail('WRITE_FAILED', `revision ${revision} already exists`);
    try {
      f.renameSync(join(revisionsDir, stagingName), target);
    } catch (error) {
      fail('WRITE_FAILED', `failed to seal revision ${revision}: ${error?.code ?? 'unknown'}`);
    }
    fsyncDir(f, revisionsDir);
  }

  function removeStaged(stagingName) {
    if (typeof stagingName !== 'string' || !STAGING_NAME.test(stagingName)) fail('INVALID_INPUT', 'staging name is invalid');
    try {
      f.rmSync(join(revisionsDir, stagingName), {recursive: true, force: true});
    } catch {
      // already removed
    }
  }

  function removeRevisionDir(revision) {
    if (!Number.isSafeInteger(revision) || revision < 1) fail('INVALID_INPUT', 'revision must be a positive integer');
    // Never delete the revision the pointer currently names.
    try {
      if (loadCurrent().revision === revision) fail('INVALID_INPUT', 'refusing to delete the currently referenced revision');
    } catch (error) {
      if (error instanceof ProfileStoreError && error.code === 'PROFILE_NOT_FOUND') {
        // no pointer: safe to clean an orphaned staged revision
      } else if (error instanceof ProfileStoreError && error.code === 'INVALID_INPUT') {
        throw error;
      }
    }
    try {
      f.rmSync(revisionDirPath(revision), {recursive: true, force: true});
    } catch {
      // best effort
    }
  }

  function defaultQuiesce() {
    // Fixture modules have no running work: an injected hook supplies reality.
    return {status: 'idle'};
  }

  function defaultVerify({revision, profile}) {
    try {
      const stored = readRevisionProfile(revision);
      if (stored.profile.composition_digest !== profile.composition_digest) {
        return {status: 'failed', reason_code: 'DIGEST_MISMATCH', diagnostics: [storeDiagnostic('DIGEST_MISMATCH', 'error', 'compose.verify_digest_mismatch')]};
      }
      const recomputed = compositionDigest(stored.profile.host_version, stored.profile.module_refs);
      if (recomputed !== stored.profile.composition_digest) {
        return {status: 'failed', reason_code: 'DIGEST_MISMATCH', diagnostics: [storeDiagnostic('DIGEST_MISMATCH', 'error', 'compose.verify_composition_digest_mismatch')]};
      }
      const current = loadCurrent();
      if (current.revision !== revision || current.composition_digest !== profile.composition_digest) {
        return {status: 'failed', reason_code: 'REVISION_CONFLICT', diagnostics: [storeDiagnostic('REVISION_CONFLICT', 'error', 'compose.verify_pointer_mismatch')]};
      }
      return {status: 'restart_required', diagnostics: [storeDiagnostic('RESTART_REQUIRED', 'warning', 'compose.host_restart_required')]};
    } catch (error) {
      return {status: 'failed', reason_code: 'JOURNAL_CORRUPT', diagnostics: [storeDiagnostic('JOURNAL_CORRUPT', 'error', 'compose.verify_revision_unreadable')]};
    }
  }

  // -------------------------------------------------------------------------
  // Single-writer lock
  // -------------------------------------------------------------------------

  function lockBusy(reason = 'compose.lock_busy') {
    return {
      ok: false,
      diagnostics: [storeDiagnostic('LOCKED', 'error', reason)],
    };
  }

  function acquireLock(operation) {
    const entry = {
      schema_version: STORE_SCHEMA_VERSION,
      pid: process.pid,
      process_start_token: PROCESS_START_TOKEN,
      operation,
      created_at: nowIso(),
    };
    const payload = serialize(entry);
    const tryCreate = () => {
      try {
        f.writeFileSync(lockPath, payload, {flag: 'wx', mode: 0o600});
        return true;
      } catch (error) {
        if (error && error.code === 'EEXIST') return false;
        throw error;
      }
    };
    if (tryCreate()) return makeLockHandle(payload);
    // An existing lock may only be cleaned when its owner process provably exited.
    let raw;
    try {
      raw = f.readFileSync(lockPath, 'utf8');
    } catch {
      return lockBusy('compose.lock_unreadable');
    }
    let existing;
    try {
      existing = JSON.parse(raw);
    } catch {
      return lockBusy('compose.lock_unreadable');
    }
    if (!isPlainObject(existing) || !Number.isSafeInteger(existing.pid) || existing.pid <= 0 || typeof existing.process_start_token !== 'string') {
      return lockBusy('compose.lock_unreadable');
    }
    let alive = true;
    try {
      process.kill(existing.pid, 0);
      alive = true;
    } catch (error) {
      if (error && error.code === 'ESRCH') alive = false;
      else alive = true; // EPERM and friends: cannot prove death -> busy
    }
    if (alive) return lockBusy();
    // Prove the stale contents did not change while we inspected them, then clean.
    let again;
    try {
      again = f.readFileSync(lockPath, 'utf8');
    } catch {
      again = null;
    }
    if (again !== raw) return lockBusy('compose.lock_changed');
    try {
      f.unlinkSync(lockPath);
    } catch {
      return lockBusy('compose.lock_unreadable');
    }
    if (!tryCreate()) return lockBusy('compose.lock_contended');
    return makeLockHandle(payload);
  }

  function makeLockHandle(payload) {
    let released = false;
    return {
      ok: true,
      release() {
        if (released) return;
        released = true;
        try {
          const currentRaw = f.readFileSync(lockPath, 'utf8');
          if (currentRaw !== payload) return; // someone else's lock: never delete
          f.unlinkSync(lockPath);
        } catch {
          // best effort: a stale lock is recoverable by the next writer
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // Preview / prepare
  // -------------------------------------------------------------------------

  const previews = new Map();

  function prunePreviews() {
    const currentMs = nowMs(clock);
    for (const [previewId, preview] of previews) {
      if (preview.expires_at_ms <= currentMs) previews.delete(previewId);
    }
  }

  function prepare(request = {}) {
    if (!isPlainObject(request)) fail('INVALID_INPUT', 'prepare request must be a plain object');
    const {selected_ids: selectedIds, expected_revision: expectedRevision, catalog, host, policy} = request;
    if (!Array.isArray(selectedIds)) fail('INVALID_INPUT', 'selected_ids must be an array');
    selectedIds.forEach((id, index) => assertModuleId(id, `selected_ids[${index}]`));
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('INVALID_INPUT', 'expected_revision must be a non-negative integer');
    if (!isPlainObject(host)) fail('INVALID_INPUT', 'host is required');
    if (!isPlainObject(policy)) fail('INVALID_INPUT', 'policy is required');
    if (!Array.isArray(catalog) || catalog.length === 0) fail('INVALID_INPUT', 'catalog must be a non-empty array of validated manifests');

    const current = loadCurrent();
    if (current.revision !== expectedRevision) {
      return {
        status: 'stale',
        diagnostics: [storeDiagnostic('STALE_REVISION', 'error', 'compose.stale_revision')],
        revision: current.revision,
        expected_revision: expectedRevision,
        composition_digest: current.composition_digest,
      };
    }

    const locks = {};
    for (const manifest of catalog) locks[manifest.id] = manifest.sha256;
    const resolved = resolveComposition({
      host,
      requested_modules: [...new Set(selectedIds)],
      locks,
      policy,
      catalog,
    });
    if (resolved.status !== 'valid') {
      return {
        status: 'blocked',
        diagnostics: resolved.diagnostics,
        resolve: resolved,
        revision: current.revision,
        composition_digest: resolved.composition_digest,
      };
    }

    const byId = new Map(catalog.map((manifest) => [manifest.id, manifest]));
    const targetRevision = current.revision + 1;
    const moduleRefs = resolved.ordered.map((id) => ({id, sha256: byId.get(id).sha256}));
    const policyDigest = digestOf(policy);
    const profile = {
      schema_version: STORE_SCHEMA_VERSION,
      profile_id: profileId,
      revision: targetRevision,
      host_version: host.version,
      module_refs: moduleRefs,
      policy_ref: POLICY_REF,
      policy_digest: policyDigest,
      composition_digest: resolved.composition_digest,
    };
    try {
      validateProfileV1(profile, 'preview.profile');
    } catch (error) {
      const detail = error instanceof ContractError ? error.message : 'invalid profile';
      fail('INVALID_INPUT', `prepared profile failed v1 validation: ${detail}`);
    }
    const orderedModules = resolved.ordered.map((id) => byId.get(id));
    const patchText = renderPatch({profile, modules: orderedModules});

    let previousProfile = null;
    if (current.revision > 0) {
      try {
        previousProfile = readRevisionProfile(current.revision).profile;
      } catch {
        previousProfile = null;
      }
    }
    const diff = diffBetween(previousProfile, {
      revision: targetRevision,
      module_refs: moduleRefs,
      composition_digest: resolved.composition_digest,
    });

    const createdMs = nowMs(clock);
    const expiresMs = createdMs + PREVIEW_TTL_MS;
    const previewId = `pv-${targetRevision}-${randomUUID()}`;
    const preview = {
      preview_id: previewId,
      profile_id: profileId,
      expected_revision: current.revision,
      base_composition_digest: current.composition_digest,
      base_policy_digest: current.policy_digest ?? null,
      composition_digest: resolved.composition_digest,
      policy_digest: policyDigest,
      selected_ids: [...resolved.ordered],
      ordered: [...resolved.ordered],
      enabled: [...resolved.enabled],
      profile,
      patch_text: patchText,
      diff,
      created_at: iso(createdMs),
      created_at_ms: createdMs,
      expires_at: iso(expiresMs),
      expires_at_ms: expiresMs,
    };
    prunePreviews();
    previews.set(previewId, preview);
    return {
      status: 'prepared',
      preview_id: previewId,
      diff,
      composition_digest: resolved.composition_digest,
      expires_at: preview.expires_at,
      expected_revision: current.revision,
      revision: targetRevision,
      policy_digest: policyDigest,
      selected_ids: preview.selected_ids,
      ordered: preview.ordered,
      enabled: preview.enabled,
      diagnostics: resolved.diagnostics.filter((diagnostic) => diagnostic.severity !== 'error'),
    };
  }

  // -------------------------------------------------------------------------
  // Apply
  // -------------------------------------------------------------------------

  async function apply(request = {}, applyOptions = {}) {
    if (!isPlainObject(request)) fail('INVALID_INPUT', 'apply request must be a plain object');
    const {preview_id: previewId, expected_revision: expectedRevision, operation_id: operationId} = request;
    if (typeof previewId !== 'string' || previewId.length === 0 || previewId.length > 128) fail('INVALID_INPUT', 'preview_id is invalid');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('INVALID_INPUT', 'expected_revision is invalid');
    if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) fail('INVALID_INPUT', 'operation_id is invalid');

    let snapshot = null;
    try {
      snapshot = loadCurrent();
    } catch {
      snapshot = null;
    }
    const acquired = acquireLock(operationId);
    if (!acquired.ok) {
      return result('denied', snapshot, acquired.diagnostics, {operation_id: operationId, preview_id: previewId});
    }

    try {
      let current;
      try {
        current = loadCurrent();
      } catch {
        return result('denied', snapshot, [storeDiagnostic('JOURNAL_CORRUPT', 'error', 'compose.current_pointer_unreadable')], {operation_id: operationId, preview_id: previewId});
      }

      let journalState;
      try {
        journalState = readJournalTolerant();
      } catch {
        return result('denied', current, [storeDiagnostic('JOURNAL_CORRUPT', 'error', 'compose.journal_unreadable')], {operation_id: operationId, preview_id: previewId});
      }
      if (journalState.corrupt.length > 0) {
        return result('denied', current, [storeDiagnostic('JOURNAL_CORRUPT', 'error', 'compose.journal_corrupt_unreadable')], {operation_id: operationId, preview_id: previewId});
      }
      // Another interrupted transaction must be recovered before a new one runs.
      const foreignUnresolved = journalState.entries.find((entry) => isUnresolvedPhase(entry.phase) && entry.operation_id !== operationId);
      if (foreignUnresolved !== undefined) {
        return result('denied', current, [storeDiagnostic('OUTCOME_UNKNOWN', 'error', 'compose.unresolved_journal_run_recover')], {operation_id: operationId, preview_id: previewId});
      }
      const existing = journalState.entries.find((entry) => entry.operation_id === operationId) ?? null;
      const preview = previews.get(previewId) ?? null;

      if (existing !== null) {
        if (preview !== null && preview.composition_digest !== existing.new_composition_digest) {
          return result('denied', current, [storeDiagnostic('IDEMPOTENCY_CONFLICT', 'error', 'compose.idempotency_conflict')], {
            operation_id: operationId,
            preview_id: previewId,
            reason_code: 'IDEMPOTENCY_CONFLICT',
            diff: preview !== null ? diffBetween(current, preview.profile) : null,
          });
        }
        if (isTerminalPhase(existing.phase)) {
          const replay = describeJournalOutcome(existing, current);
          return {...replay, operation_id: operationId, preview_id: previewId};
        }
        // The same operation is known but unfinished: never run it twice.
        return result('outcome_unknown', current, [storeDiagnostic('OUTCOME_UNKNOWN', 'error', 'compose.operation_incomplete_run_recover')], {
          operation_id: operationId,
          preview_id: previewId,
        });
      }

      if (preview === null) {
        return result('stale', current, [storeDiagnostic('STALE_PREVIEW', 'error', 'compose.preview_unknown')], {operation_id: operationId, preview_id: previewId});
      }
      if (preview.profile_id !== profileId) {
        return result('denied', current, [storeDiagnostic('INVALID_REQUEST', 'error', 'compose.preview_other_profile')], {operation_id: operationId, preview_id: previewId});
      }
      if (expectedRevision !== preview.expected_revision) {
        // The preview binds expected_revision: a different request cannot reuse it.
        return result('stale', current, [storeDiagnostic('STALE_PREVIEW', 'error', 'compose.preview_revision_mismatch')], {operation_id: operationId, preview_id: previewId});
      }
      if (nowMs(clock) >= preview.expires_at_ms) {
        previews.delete(previewId);
        return result('stale', current, [storeDiagnostic('STALE_PREVIEW', 'error', 'compose.preview_expired')], {operation_id: operationId, preview_id: previewId});
      }
      if (current.revision !== preview.expected_revision) {
        return result('denied', current, [
          storeDiagnostic('REVISION_CONFLICT', 'error', 'compose.revision_changed_outside_store'),
          storeDiagnostic('STALE_PREVIEW', 'error', 'compose.preview_base_changed'),
        ], {
          operation_id: operationId,
          preview_id: previewId,
          reason_code: 'REVISION_CONFLICT',
          diff: diffBetween(current, preview.profile),
        });
      }
      if (current.composition_digest !== preview.base_composition_digest
        || (current.policy_digest ?? null) !== preview.base_policy_digest) {
        return result('denied', current, [
          storeDiagnostic('REVISION_CONFLICT', 'error', 'compose.current_digest_changed_outside_store'),
          storeDiagnostic('STALE_PREVIEW', 'error', 'compose.preview_base_changed'),
        ], {
          operation_id: operationId,
          preview_id: previewId,
          reason_code: 'REVISION_CONFLICT',
          diff: diffBetween(current, preview.profile),
        });
      }

      if (current.composition_digest === preview.composition_digest) {
        // No-op: the requested composition is already current; no new revision.
        const phaseStatus = current.status === 'switching' ? 'outcome_unknown' : current.status === 'restart_required' ? 'restart_required' : 'active';
        try {
          writeJournal({
            schema_version: STORE_SCHEMA_VERSION,
            profile_id: profileId,
            operation_id: operationId,
            preview_id: previewId,
            phase: 'no_change',
            revision: current.revision,
            previous_revision: current.revision,
            previous_current: {...current},
            previous_composition_digest: current.composition_digest,
            previous_profile_sha256: null,
            new_composition_digest: current.composition_digest,
            policy_digest: current.policy_digest ?? preview.policy_digest,
            selected_ids: preview.selected_ids,
            created_at: nowIso(),
            updated_at: nowIso(),
            finalized_at: nowIso(),
          });
        } catch {
          // The no-op result stays valid even if the replay marker failed to persist.
        }
        return result(phaseStatus, current, [storeDiagnostic('NO_CHANGE', 'info', 'compose.no_change')], {
          operation_id: operationId,
          preview_id: previewId,
          no_op: true,
          reason_code: 'NO_CHANGE',
        });
      }

      return await applyComposition(internal, {
        preview,
        expected_revision: expectedRevision,
        operation_id: operationId,
        verify: applyOptions.verify,
        quiesce: applyOptions.quiesce,
        crashAfter: applyOptions.crashAfter,
      });
    } catch (error) {
      if (error?.simulated_crash === true) throw error;
      let after = snapshot;
      try {
        after = loadCurrent();
      } catch {
        after = snapshot;
      }
      return result('outcome_unknown', after, [storeDiagnostic('INTERNAL_FAILURE', 'error', 'compose.apply_internal_failure')], {
        operation_id: operationId,
        preview_id: previewId,
      });
    } finally {
      acquired.release();
    }
  }

  // -------------------------------------------------------------------------
  // Recover
  // -------------------------------------------------------------------------

  function recover(options = {}) {
    const dryRun = options.dry_run === true;
    let snapshot = null;
    try {
      snapshot = loadCurrent();
    } catch {
      snapshot = null;
    }
    const acquired = acquireLock('recover');
    if (!acquired.ok) {
      return {
        status: 'denied',
        revision: snapshot?.revision ?? null,
        previous_revision: snapshot?.revision ?? null,
        composition_digest: snapshot?.composition_digest ?? null,
        diagnostics: acquired.diagnostics,
        recovered: false,
        dry_run: dryRun,
        actions: [],
        operation_id: null,
      };
    }
    try {
      return recoverComposition(internal, {dry_run: dryRun});
    } finally {
      acquired.release();
    }
  }

  const internal = {
    profileId,
    emptyCompositionDigest: EMPTY_COMPOSITION_DIGEST,
    nowIso,
    loadCurrent,
    readRevisionProfile,
    readJournalTolerant,
    writeJournal,
    writeCurrent,
    restoreCurrent,
    stageRevision,
    commitRevision,
    removeStaged,
    removeRevisionDir,
    defaultQuiesce,
    defaultVerify,
  };

  return {
    profile_id: profileId,
    root: rootPath,
    profile_dir: profileDir,
    paths: Object.freeze({
      root: rootPath,
      profile: profileDir,
      revisions: revisionsDir,
      journal: journalDir,
      current: currentPath,
      lock: lockPath,
    }),
    store_created: rootInfo.created,
    loadCurrent,
    listRevisions,
    readJournal() {
      const state = readJournalTolerant();
      if (state.corrupt.length > 0) fail('JOURNAL_CORRUPT', 'journal contains unreadable entries');
      return [...state.entries].sort((left, right) => {
        if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1;
        return left.operation_id < right.operation_id ? -1 : left.operation_id > right.operation_id ? 1 : 0;
      });
    },
    readJournalTolerant,
    diffBetween,
    prepare,
    apply,
    recover,
    revisionDir: revisionDirPath,
    _internal: internal,
  };
}

// ---------------------------------------------------------------------------
// Root / directory ownership
// ---------------------------------------------------------------------------

function ensureRoot(f, {rootPath, allowCreate, clock}) {
  let stat = null;
  try {
    stat = f.lstatSync(rootPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (stat === null) {
    if (!allowCreate) fail('PROFILE_NOT_FOUND', 'scratch root does not exist');
    assertPathChainLocal(f, dirname(rootPath));
    let parentStat;
    try {
      parentStat = f.statSync(dirname(rootPath));
    } catch {
      fail('PATH_UNTRUSTED', 'scratch root parent does not exist; only empty/new directories are created');
    }
    if (!parentStat.isDirectory()) fail('PATH_UNTRUSTED', 'scratch root parent is not a directory');
    f.mkdirSync(rootPath);
    stat = f.lstatSync(rootPath);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('PATH_UNTRUSTED', 'scratch root must be a real directory');

  const markerPath = join(rootPath, PROFILE_MARKER);
  let markerStat = null;
  try {
    markerStat = f.lstatSync(markerPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (markerStat !== null) {
    if (markerStat.isSymbolicLink() || !markerStat.isFile()) fail('PATH_UNTRUSTED', 'profile marker must be a regular file');
    let marker;
    try {
      marker = JSON.parse(f.readFileSync(markerPath, 'utf8'));
    } catch {
      fail('PATH_UNTRUSTED', 'profile marker is unreadable');
    }
    if (!isPlainObject(marker) || marker.schema_version !== STORE_SCHEMA_VERSION || marker.kind !== MARKER_KIND) {
      fail('PATH_UNTRUSTED', 'profile marker was not created by this tool');
    }
    return {created: false};
  }

  const entries = f.readdirSync(rootPath);
  if (entries.length > 0) {
    fail('PATH_UNTRUSTED', 'existing non-empty directory has no .workbench-profile marker; refusing to adopt it');
  }
  if (!allowCreate) fail('PATH_UNTRUSTED', 'missing .workbench-profile marker; refusing a non-scratch directory');
  const marker = {
    schema_version: STORE_SCHEMA_VERSION,
    kind: MARKER_KIND,
    tool: '08-workbench-ui/profile-store',
    created_at: iso(nowMs(clock)),
  };
  writeFileDurable(f, markerPath, serialize(marker));
  fsyncDir(f, rootPath);
  return {created: true};
}

function ensureOwnedDir(f, dirPath, allowCreate) {
  let stat = null;
  try {
    stat = f.lstatSync(dirPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (stat === null) {
    if (!allowCreate) fail('PROFILE_NOT_FOUND', `required scratch directory is missing: ${dirPath}`);
    f.mkdirSync(dirPath, {recursive: true});
    stat = f.lstatSync(dirPath);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('PATH_UNTRUSTED', `scratch path must be a real directory: ${dirPath}`);
}
