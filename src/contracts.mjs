// Strict v1 contracts for the local workbench (UI-API-MANIFEST / UI-API-MODULE).
//
// Every external or file-sourced value crosses these validators. They reject
// unknown fields instead of dropping them, cap text/array sizes, and keep
// machine paths and URLs out of data that later reaches the UI. The validators
// are deliberately hand-written (no schema library at runtime): the workbench
// must run with the pinned runtime and its review surface is this file.
import {createHash} from 'node:crypto';

export const SCHEMA_VERSION = 1;

/** Pinned Host identity. Re-verify before every real install; never infer. */
export const HOST_BASELINE = Object.freeze({
  version: '0.2.1-rc.5',
  electron: '44.7.0',
  embedded_node: '24.21.0',
  build_commit: 'd4db512a969fccf0c5cc7ec8fe38e9c1d27af916',
  app_asar_sha256: 'e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915',
  executable_sha256: '7ae939b5a82b220fbd8ad04dfbafaaedb5a49ab43dc884a5db6381f678dd0cc4',
});

export const LIMITS = Object.freeze({
  max_manifests: 32,
  max_dependency_edges: 256,
  max_diagnostics: 1000,
  max_text: 512,
  max_short_text: 128,
  max_refs: 32,
  max_modules_per_profile: 32,
  max_active_operations: 32,
  max_tools: 128,
  max_slots: 64,
  max_writers: 32,
  max_hooks: 32,
  max_status_modules: 32,
  max_request_bytes: 64 * 1024,
  max_response_bytes: 1024 * 1024,
});

/** Modules that may declare a v1 manifest. 08 is the composer, never a module. */
export const MANIFEST_MODULE_IDS = Object.freeze(['01', '02', '03', '04', '05', '06', '07']);

/** Deterministic same-level ordering after topological sort. */
export const PREFERRED_ORDER = Object.freeze(['05', '07', '06', '03', '04', '02', '01']);

export const NETWORK_MODES = Object.freeze(['none', 'approved_model', 'trusted_targets']);
export const ENTRY_KINDS = Object.freeze(['panel', 'host_command', 'skill']);
export const SLOT_MODES = Object.freeze(['single', 'keyed', 'list']);
export const OPERATION_KINDS = Object.freeze(['read', 'write']);
export const WRITER_SCOPES = Object.freeze(['global', 'scope', 'session']);
export const HOOK_MODES = Object.freeze(['observe', 'exclusive_mutate']);
export const MODULE_STATES = Object.freeze(['ready', 'busy', 'attention', 'disabled', 'blocked', 'unavailable']);
export const ACTIVE_OPERATION_STATES = Object.freeze(['queued', 'running', 'cancelling', 'outcome_unknown']);
export const ACTION_STATUSES = Object.freeze(['accepted', 'denied', 'stale', 'unavailable']);
export const NAV_CLIENT_STATES = Object.freeze(['opened', 'instruction_shown', 'unavailable', 'stale']);
export const BUSINESS_STATUSES = Object.freeze(['ok', 'denied', 'stale', 'invalid', 'unavailable', 'failed']);
export const DIAGNOSTIC_SEVERITIES = Object.freeze(['error', 'warning', 'info']);
export const COMPOSE_STATUSES = Object.freeze(['active', 'stale', 'denied', 'restart_required', 'rolled_back', 'partial', 'outcome_unknown']);

/** Fixed reason-code whitelist shared by RPC, actions and diagnostics. */
export const REASON_CODES = Object.freeze([
  'OWNER_REQUIRED',
  'CONTEXT_UNBOUND',
  'SCOPE_REVOKED',
  'PROFILE_DENIED',
  'MODULE_DENIED',
  'STALE_SCOPE',
  'STALE_REVISION',
  'STALE_PREVIEW',
  'UNKNOWN_ENDPOINT',
  'LIMIT_EXCEEDED',
  'INTERNAL_FAILURE',
  'TRANSPORT_FAILURE',
  'INVALID_REQUEST',
  'EXPIRED_INTENT',
  'TARGET_UNREGISTERED',
  'MODULE_BUSY',
  'NOT_READY',
  'DIGEST_MISMATCH',
  'UNKNOWN_MODULE',
  'DEPENDENCY_MISSING',
  'DEPENDENCY_CYCLE',
  'TOOL_CONFLICT',
  'SLOT_CONFLICT',
  'WRITER_CONFLICT',
  'HOOK_CONFLICT',
  'HOST_INCOMPATIBLE',
  'NETWORK_POLICY',
  'DIAGNOSTIC_ERROR',
  'PROFILE_NOT_FOUND',
  'REVISION_CONFLICT',
  'LOCKED',
  'PATH_UNTRUSTED',
  'JOURNAL_CORRUPT',
  'IDEMPOTENCY_CONFLICT',
  'UNKNOWN_OPERATION',
  'QUIESCE_BUSY',
  'QUIESCE_UNKNOWN',
  'WRITE_FAILED',
  'RESTART_REQUIRED',
  'ROLLED_BACK',
  'PARTIAL',
  'OUTCOME_UNKNOWN',
  'NO_CHANGE',
  'INVALID_INPUT',
]);

const REASON_CODE_SET = new Set(REASON_CODES);
const STABLE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODULE_ID = /^(0[1-8])$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RESOURCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/;
const MESSAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

export class ContractError extends Error {
  constructor(code, path, message) {
    super(`${path}: ${message}`);
    this.name = 'ContractError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new ContractError(code, path, message);
}

export function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value, path) {
  if (!isPlainObject(value)) fail('INVALID_TYPE', path, 'must be a plain object');
  return value;
}

function keys(value, path, {required = [], optional = []} = {}) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('UNKNOWN_FIELD', `${path}.${key}`, 'unknown field is rejected');
  }
  for (const key of required) {
    if (!(key in value)) fail('MISSING_FIELD', `${path}.${key}`, 'required field is missing');
  }
  return value;
}

function string(value, path, {max = LIMITS.max_text, pattern = null, allowEmpty = false} = {}) {
  if (typeof value !== 'string') fail('INVALID_TYPE', path, 'must be a string');
  if (!allowEmpty && value.trim() === '') fail('INVALID_VALUE', path, 'must not be empty');
  if (value.length > max) fail('LIMIT_EXCEEDED', path, `max ${max} characters`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) fail('INVALID_VALUE', path, 'control characters are rejected');
  if (pattern !== null && !pattern.test(value)) fail('INVALID_VALUE', path, `does not match ${pattern}`);
  return value;
}

function boolean(value, path) {
  if (typeof value !== 'boolean') fail('INVALID_TYPE', path, 'must be a boolean');
  return value;
}

function integer(value, path, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) {
  if (!Number.isSafeInteger(value)) fail('INVALID_TYPE', path, 'must be a safe integer');
  if (value < min || value > max) fail('INVALID_VALUE', path, `must be between ${min} and ${max}`);
  return value;
}

function array(value, path, {min = 0, max = LIMITS.max_refs, of} = {}) {
  if (!Array.isArray(value)) fail('INVALID_TYPE', path, 'must be an array');
  if (value.length < min) fail('INVALID_VALUE', path, `at least ${min} entries`);
  if (value.length > max) fail('LIMIT_EXCEEDED', path, `max ${max} entries`);
  if (typeof of === 'function') value.forEach((item, index) => of(item, `${path}[${index}]`));
  return value;
}

export function assertModuleId(value, path = 'id') {
  if (typeof value !== 'string' || !MODULE_ID.test(value)) fail('INVALID_VALUE', path, 'must be a module id "01".."08"');
  return value;
}

export function assertManifestModuleId(value, path = 'id') {
  assertModuleId(value, path);
  if (!MANIFEST_MODULE_IDS.includes(value)) fail('INVALID_VALUE', path, 'manifest id must be 01..07');
  return value;
}

export function assertStableId(value, path = 'id') {
  if (typeof value !== 'string' || !STABLE_ID.test(value)) fail('INVALID_VALUE', path, 'must be a lower-case stable id');
  return value;
}

export function assertSha256(value, path = 'sha256') {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('INVALID_VALUE', path, 'must be 64 lower-case hex characters');
  return value;
}

export function assertVersion(value, path = 'version') {
  if (typeof value !== 'string' || !VERSION.test(value)) fail('INVALID_VALUE', path, 'must be a semantic version');
  return value;
}

/** npm package identity (scoped or unscoped), used by source-lock artifacts. */
export function assertPackageName(value, path = 'package') {
  if (typeof value !== 'string' || !PACKAGE_NAME.test(value)) fail('INVALID_VALUE', path, 'must be an npm package name');
  return value;
}

export function assertRef(value, path = 'ref') {
  if (typeof value !== 'string' || !RESOURCE_REF.test(value)) fail('INVALID_VALUE', path, 'must be a stable local reference');
  if (value.includes('..')) fail('INVALID_VALUE', path, 'parent traversal is rejected');
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) fail('INVALID_VALUE', path, 'URLs and schemes are rejected');
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{2}|\\\\)/.test(value)) fail('INVALID_VALUE', path, 'absolute or UNC paths are rejected');
  return value;
}

export function assertReasonCode(value, path = 'reason_code') {
  if (value === null) return null;
  if (typeof value !== 'string' || !REASON_CODE_SET.has(value)) fail('INVALID_VALUE', path, 'must be a registered reason code');
  return value;
}

function oneOf(value, path, values) {
  if (!values.includes(value)) fail('INVALID_VALUE', path, `must be one of ${values.join(', ')}`);
  return value;
}

// ---------------------------------------------------------------------------
// ModuleManifestV1
// ---------------------------------------------------------------------------

function toolEntry(value, path) {
  object(value, path);
  keys(value, path, {required: ['name', 'operation_kind']});
  string(value.name, `${path}.name`, {max: LIMITS.max_short_text, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/});
  oneOf(value.operation_kind, `${path}.operation_kind`, OPERATION_KINDS);
}

function slotEntry(value, path) {
  object(value, path);
  keys(value, path, {required: ['name', 'key', 'mode']});
  string(value.name, `${path}.name`, {max: LIMITS.max_short_text});
  if (value.key !== null) string(value.key, `${path}.key`, {max: LIMITS.max_short_text, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/});
  oneOf(value.mode, `${path}.mode`, SLOT_MODES);
}

function writerEntry(value, path) {
  object(value, path);
  keys(value, path, {required: ['resource', 'scope']});
  string(value.resource, `${path}.resource`, {max: LIMITS.max_short_text, pattern: RESOURCE_REF});
  oneOf(value.scope, `${path}.scope`, WRITER_SCOPES);
}

function hookEntry(value, path) {
  object(value, path);
  keys(value, path, {required: ['name', 'mode']});
  string(value.name, `${path}.name`, {max: LIMITS.max_short_text});
  oneOf(value.mode, `${path}.mode`, HOOK_MODES);
}

function serviceRequirement(value, path) {
  object(value, path);
  keys(value, path, {required: ['name', 'shape_revision']});
  string(value.name, `${path}.name`, {max: LIMITS.max_short_text, pattern: /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/});
  string(value.shape_revision, `${path}.shape_revision`, {max: LIMITS.max_short_text});
}

function dependency(value, path) {
  object(value, path);
  keys(value, path, {required: ['module_id', 'contract_major', 'optional']});
  assertModuleId(value.module_id, `${path}.module_id`);
  if (value.contract_major !== 1) fail('INVALID_VALUE', `${path}.contract_major`, 'only contract major 1 exists');
  boolean(value.optional, `${path}.optional`);
}

export function validateModuleManifest(value, path = 'manifest') {
  object(value, path);
  keys(value, path, {
    required: ['schema_version', 'id', 'name', 'release_version', 'artifact_ref', 'sha256', 'host', 'requires', 'provides', 'network', 'dispose', 'entry', 'evidence'],
  });
  if (value.schema_version !== SCHEMA_VERSION) fail('INVALID_VALUE', `${path}.schema_version`, `must be ${SCHEMA_VERSION}`);
  assertManifestModuleId(value.id, `${path}.id`);
  string(value.name, `${path}.name`, {max: LIMITS.max_short_text});
  assertVersion(value.release_version, `${path}.release_version`);
  assertRef(value.artifact_ref, `${path}.artifact_ref`);
  assertSha256(value.sha256, `${path}.sha256`);

  object(value.host, `${path}.host`);
  keys(value.host, `${path}.host`, {required: ['verified_versions', 'declared_range', 'services']});
  array(value.host.verified_versions, `${path}.host.verified_versions`, {min: 1, max: 16, of: (item, itemPath) => assertVersion(item, itemPath)});
  string(value.host.declared_range, `${path}.host.declared_range`, {max: 256});
  array(value.host.services, `${path}.host.services`, {max: 32, of: serviceRequirement});

  array(value.requires, `${path}.requires`, {max: LIMITS.max_dependency_edges, of: dependency});

  object(value.provides, `${path}.provides`);
  keys(value.provides, `${path}.provides`, {required: ['tools', 'slots', 'writers', 'hooks']});
  array(value.provides.tools, `${path}.provides.tools`, {max: LIMITS.max_tools, of: toolEntry});
  array(value.provides.slots, `${path}.provides.slots`, {max: LIMITS.max_slots, of: slotEntry});
  array(value.provides.writers, `${path}.provides.writers`, {max: LIMITS.max_writers, of: writerEntry});
  array(value.provides.hooks, `${path}.provides.hooks`, {max: LIMITS.max_hooks, of: hookEntry});

  object(value.network, `${path}.network`);
  keys(value.network, `${path}.network`, {required: ['mode', 'target_refs']});
  oneOf(value.network.mode, `${path}.network.mode`, NETWORK_MODES);
  array(value.network.target_refs, `${path}.network.target_refs`, {max: LIMITS.max_refs, of: (item, itemPath) => assertRef(item, itemPath)});
  if (value.network.mode === 'none' && value.network.target_refs.length !== 0) {
    fail('INVALID_VALUE', `${path}.network.target_refs`, 'a no-network module must not declare target references');
  }

  object(value.dispose, `${path}.dispose`);
  keys(value.dispose, `${path}.dispose`, {required: ['supports_quiesce', 'timeout_ms']});
  boolean(value.dispose.supports_quiesce, `${path}.dispose.supports_quiesce`);
  integer(value.dispose.timeout_ms, `${path}.dispose.timeout_ms`, {min: 0, max: 600000});

  object(value.entry, `${path}.entry`);
  keys(value.entry, `${path}.entry`, {required: ['kind', 'ref']});
  oneOf(value.entry.kind, `${path}.entry.kind`, ENTRY_KINDS);
  assertRef(value.entry.ref, `${path}.entry.ref`);

  object(value.evidence, `${path}.evidence`);
  keys(value.evidence, `${path}.evidence`, {required: ['release_ref', 'contract_tests_ref', 'host_smoke_ref', 'network_ref']});
  for (const field of ['release_ref', 'contract_tests_ref', 'host_smoke_ref', 'network_ref']) assertRef(value.evidence[field], `${path}.evidence.${field}`);
  return value;
}

// ---------------------------------------------------------------------------
// ProfileV1
// ---------------------------------------------------------------------------

export function validateProfileV1(value, path = 'profile') {
  object(value, path);
  keys(value, path, {required: ['schema_version', 'profile_id', 'revision', 'host_version', 'module_refs', 'policy_ref', 'policy_digest', 'composition_digest']});
  if (value.schema_version !== SCHEMA_VERSION) fail('INVALID_VALUE', `${path}.schema_version`, `must be ${SCHEMA_VERSION}`);
  assertStableId(value.profile_id, `${path}.profile_id`);
  integer(value.revision, `${path}.revision`, {min: 0, max: Number.MAX_SAFE_INTEGER});
  if (value.host_version !== HOST_BASELINE.version) fail('INVALID_VALUE', `${path}.host_version`, `must be the pinned ${HOST_BASELINE.version}`);
  array(value.module_refs, `${path}.module_refs`, {max: LIMITS.max_modules_per_profile, of: (item, itemPath) => {
    object(item, itemPath);
    keys(item, itemPath, {required: ['id', 'sha256']});
    assertModuleId(item.id, `${itemPath}.id`);
    assertSha256(item.sha256, `${itemPath}.sha256`);
  }});
  const ids = value.module_refs.map((item) => item.id);
  if (new Set(ids).size !== ids.length) fail('INVALID_VALUE', `${path}.module_refs`, 'module ids must be unique');
  assertRef(value.policy_ref, `${path}.policy_ref`);
  assertSha256(value.policy_digest, `${path}.policy_digest`);
  assertSha256(value.composition_digest, `${path}.composition_digest`);
  return value;
}

// ---------------------------------------------------------------------------
// ModuleDescriptorV1 / ModuleStatusV1 / ActionResultV1 / NavigationIntentV1
// ---------------------------------------------------------------------------

const DESCRIPTOR_METHODS = ['getStatus', 'subscribe', 'planOpen', 'quiesce', 'dispose'];

export function validateModuleDescriptorV1(value, path = 'descriptor') {
  if (!isPlainObject(value)) fail('INVALID_TYPE', path, 'descriptor must be an in-process object, not serialized JSON');
  if (value.contract_version !== 1) fail('INVALID_VALUE', `${path}.contract_version`, 'must be 1');
  string(value.id, `${path}.id`, {max: LIMITS.max_short_text});
  assertVersion(value.release_version, `${path}.release_version`);
  object(value.entry, `${path}.entry`);
  keys(value.entry, `${path}.entry`, {required: ['kind', 'ref']});
  oneOf(value.entry.kind, `${path}.entry.kind`, ENTRY_KINDS);
  assertRef(value.entry.ref, `${path}.entry.ref`);
  for (const method of DESCRIPTOR_METHODS) {
    if (typeof value[method] !== 'function') fail('INVALID_TYPE', `${path}.${method}`, 'descriptor method must be a function');
  }
  return value;
}

export function validateTrustedContext(value, path = 'context') {
  object(value, path);
  keys(value, path, {required: ['scope_ref', 'scope_generation', 'session_ref', 'caller_ref', 'context_revision']});
  assertRef(value.scope_ref, `${path}.scope_ref`);
  integer(value.scope_generation, `${path}.scope_generation`, {min: 1});
  if (value.session_ref !== null) assertRef(value.session_ref, `${path}.session_ref`);
  assertRef(value.caller_ref, `${path}.caller_ref`);
  string(value.context_revision, `${path}.context_revision`, {max: LIMITS.max_short_text});
  return value;
}

export function validateModuleStatusV1(value, path = 'status') {
  object(value, path);
  keys(value, path, {required: ['schema_version', 'module_id', 'scope_ref', 'session_ref', 'generation', 'revision', 'state', 'reason_code', 'active_operations', 'updated_at', 'capabilities']});
  if (value.schema_version !== SCHEMA_VERSION) fail('INVALID_VALUE', `${path}.schema_version`, `must be ${SCHEMA_VERSION}`);
  assertModuleId(value.module_id, `${path}.module_id`);
  assertRef(value.scope_ref, `${path}.scope_ref`);
  if (value.session_ref !== null) assertRef(value.session_ref, `${path}.session_ref`);
  integer(value.generation, `${path}.generation`, {min: 0});
  integer(value.revision, `${path}.revision`, {min: 0});
  oneOf(value.state, `${path}.state`, MODULE_STATES);
  assertReasonCode(value.reason_code, `${path}.reason_code`);
  array(value.active_operations, `${path}.active_operations`, {max: LIMITS.max_active_operations, of: (item, itemPath) => {
    object(item, itemPath);
    keys(item, itemPath, {required: ['operation_id', 'kind', 'state']});
    string(item.operation_id, `${itemPath}.operation_id`, {max: LIMITS.max_short_text});
    string(item.kind, `${itemPath}.kind`, {max: LIMITS.max_short_text});
    oneOf(item.state, `${itemPath}.state`, ACTIVE_OPERATION_STATES);
  }});
  string(value.updated_at, `${path}.updated_at`, {max: 64, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/});
  array(value.capabilities, `${path}.capabilities`, {max: LIMITS.max_refs, of: (item, itemPath) => string(item, itemPath, {max: LIMITS.max_short_text})});
  return value;
}

export function validateActionResultV1(value, path = 'action') {
  object(value, path);
  keys(value, path, {required: ['schema_version', 'operation_id', 'status', 'owner_module', 'reason_code', 'navigation_intent']});
  if (value.schema_version !== SCHEMA_VERSION) fail('INVALID_VALUE', `${path}.schema_version`, `must be ${SCHEMA_VERSION}`);
  string(value.operation_id, `${path}.operation_id`, {max: LIMITS.max_short_text});
  oneOf(value.status, `${path}.status`, ACTION_STATUSES);
  assertModuleId(value.owner_module, `${path}.owner_module`);
  assertReasonCode(value.reason_code, `${path}.reason_code`);
  if (value.navigation_intent !== null) validateNavigationIntentV1(value.navigation_intent, `${path}.navigation_intent`);
  if (value.status === 'accepted' && value.navigation_intent === null) fail('INVALID_VALUE', `${path}.navigation_intent`, 'accepted must carry the prepared navigation intent');
  return value;
}

export function validateNavigationIntentV1(value, path = 'intent') {
  object(value, path);
  keys(value, path, {required: ['schema_version', 'intent_id', 'operation_id', 'owner_module', 'scope_ref', 'scope_generation', 'context_revision', 'module_revision', 'composition_digest', 'expires_at', 'target']});
  if (value.schema_version !== SCHEMA_VERSION) fail('INVALID_VALUE', `${path}.schema_version`, `must be ${SCHEMA_VERSION}`);
  string(value.intent_id, `${path}.intent_id`, {max: LIMITS.max_short_text});
  string(value.operation_id, `${path}.operation_id`, {max: LIMITS.max_short_text});
  assertModuleId(value.owner_module, `${path}.owner_module`);
  assertRef(value.scope_ref, `${path}.scope_ref`);
  integer(value.scope_generation, `${path}.scope_generation`, {min: 1});
  string(value.context_revision, `${path}.context_revision`, {max: LIMITS.max_short_text});
  integer(value.module_revision, `${path}.module_revision`, {min: 0});
  assertSha256(value.composition_digest, `${path}.composition_digest`);
  string(value.expires_at, `${path}.expires_at`, {max: 64, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/});
  object(value.target, `${path}.target`);
  if (value.target.kind === 'panel') {
    keys(value.target, `${path}.target`, {required: ['kind', 'panel_key']});
    assertStableId(value.target.panel_key, `${path}.target.panel_key`);
  } else if (value.target.kind === 'skill') {
    keys(value.target, `${path}.target`, {required: ['kind', 'skill_ref', 'instruction_key']});
    assertRef(value.target.skill_ref, `${path}.target.skill_ref`);
    assertStableId(value.target.instruction_key, `${path}.target.instruction_key`);
  } else if (value.target.kind === 'host_command') {
    keys(value.target, `${path}.target`, {required: ['kind', 'command_ref', 'instruction_key']});
    assertRef(value.target.command_ref, `${path}.target.command_ref`);
    assertStableId(value.target.instruction_key, `${path}.target.instruction_key`);
  } else {
    fail('INVALID_VALUE', `${path}.target.kind`, 'must be panel, skill or host_command');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Diagnostics / resolve / composition / access
// ---------------------------------------------------------------------------

export function validateDiagnostic(value, path = 'diagnostic') {
  object(value, path);
  keys(value, path, {required: ['code', 'severity', 'module_ids', 'resource_ref', 'message_key'], optional: ['evidence_ref']});
  string(value.code, `${path}.code`, {max: 64, pattern: DIAGNOSTIC_CODE});
  oneOf(value.severity, `${path}.severity`, DIAGNOSTIC_SEVERITIES);
  array(value.module_ids, `${path}.module_ids`, {max: 8, of: (item, itemPath) => assertModuleId(item, itemPath)});
  if (value.resource_ref !== null) assertRef(value.resource_ref, `${path}.resource_ref`);
  string(value.message_key, `${path}.message_key`, {max: 128, pattern: MESSAGE_KEY});
  if (value.evidence_ref !== undefined) assertRef(value.evidence_ref, `${path}.evidence_ref`);
  return value;
}

export function validateResolveRequest(value, path = 'request') {
  object(value, path);
  keys(value, path, {required: ['host', 'requested_modules', 'locks', 'policy']});
  object(value.host, `${path}.host`);
  keys(value.host, `${path}.host`, {required: ['version'], optional: ['app_asar_sha256', 'executable_sha256']});
  assertVersion(value.host.version, `${path}.host.version`);
  if (value.host.app_asar_sha256 !== undefined) assertSha256(value.host.app_asar_sha256, `${path}.host.app_asar_sha256`);
  if (value.host.executable_sha256 !== undefined) assertSha256(value.host.executable_sha256, `${path}.host.executable_sha256`);
  array(value.requested_modules, `${path}.requested_modules`, {max: LIMITS.max_manifests, of: (item, itemPath) => assertManifestModuleId(item, itemPath)});
  object(value.locks, `${path}.locks`);
  for (const [id, digest] of Object.entries(value.locks)) {
    assertManifestModuleId(id, `${path}.locks.${id}`);
    assertSha256(digest, `${path}.locks.${id}`);
  }
  object(value.policy, `${path}.policy`);
  keys(value.policy, `${path}.policy`, {required: ['network_mode'], optional: ['allowed_target_refs', 'allowed_module_ids']});
  oneOf(value.policy.network_mode, `${path}.policy.network_mode`, NETWORK_MODES);
  if (value.policy.allowed_target_refs !== undefined) array(value.policy.allowed_target_refs, `${path}.policy.allowed_target_refs`, {max: LIMITS.max_refs, of: (item, itemPath) => assertRef(item, itemPath)});
  if (value.policy.allowed_module_ids !== undefined) array(value.policy.allowed_module_ids, `${path}.policy.allowed_module_ids`, {max: LIMITS.max_manifests, of: (item, itemPath) => assertManifestModuleId(item, itemPath)});
  return value;
}

export function validateResolveResult(value, path = 'result') {
  object(value, path);
  keys(value, path, {required: ['status', 'enabled', 'disabled', 'ordered', 'composition_digest', 'diagnostics']});
  oneOf(value.status, `${path}.status`, ['valid', 'blocked']);
  array(value.enabled, `${path}.enabled`, {max: LIMITS.max_manifests, of: (item, itemPath) => assertManifestModuleId(item, itemPath)});
  array(value.disabled, `${path}.disabled`, {max: LIMITS.max_diagnostics, of: validateDiagnostic});
  array(value.ordered, `${path}.ordered`, {max: LIMITS.max_manifests, of: (item, itemPath) => assertManifestModuleId(item, itemPath)});
  assertSha256(value.composition_digest, `${path}.composition_digest`);
  array(value.diagnostics, `${path}.diagnostics`, {max: LIMITS.max_diagnostics, of: validateDiagnostic});
  return value;
}

export function validatePrepareRequest(value, path = 'request') {
  object(value, path);
  keys(value, path, {required: ['profile_ref', 'expected_revision', 'selected_ids']});
  assertRef(value.profile_ref, `${path}.profile_ref`);
  integer(value.expected_revision, `${path}.expected_revision`, {min: 0});
  array(value.selected_ids, `${path}.selected_ids`, {max: LIMITS.max_manifests, of: (item, itemPath) => assertManifestModuleId(item, itemPath)});
  return value;
}

export function validateApplyRequest(value, path = 'request') {
  object(value, path);
  keys(value, path, {required: ['preview_id', 'expected_revision', 'operation_id']});
  string(value.preview_id, `${path}.preview_id`, {max: LIMITS.max_short_text});
  integer(value.expected_revision, `${path}.expected_revision`, {min: 0});
  string(value.operation_id, `${path}.operation_id`, {max: LIMITS.max_short_text});
  return value;
}

export function validateAccessRegistryV1(value, path = 'access') {
  object(value, path);
  keys(value, path, {required: ['schema_version', 'revision', 'contexts', 'profile_refs']});
  if (value.schema_version !== SCHEMA_VERSION) fail('INVALID_VALUE', `${path}.schema_version`, `must be ${SCHEMA_VERSION}`);
  integer(value.revision, `${path}.revision`, {min: 0});
  array(value.contexts, `${path}.contexts`, {max: 64, of: (item, itemPath) => {
    object(item, itemPath);
    keys(item, itemPath, {required: ['context_ref', 'scope_ref', 'scope_generation', 'session_ref', 'allowed_module_ids', 'active']});
    assertStableId(item.context_ref, `${itemPath}.context_ref`);
    assertRef(item.scope_ref, `${itemPath}.scope_ref`);
    integer(item.scope_generation, `${itemPath}.scope_generation`, {min: 1});
    if (item.session_ref !== null) assertRef(item.session_ref, `${itemPath}.session_ref`);
    array(item.allowed_module_ids, `${itemPath}.allowed_module_ids`, {max: 8, of: (moduleId, modulePath) => assertModuleId(moduleId, modulePath)});
    boolean(item.active, `${itemPath}.active`);
  }});
  const refs = value.contexts.map((item) => item.context_ref);
  if (new Set(refs).size !== refs.length) fail('INVALID_VALUE', `${path}.contexts`, 'context_ref must be unique');
  array(value.profile_refs, `${path}.profile_refs`, {max: LIMITS.max_refs, of: (item, itemPath) => assertRef(item, itemPath)});
  return value;
}

// ---------------------------------------------------------------------------
// RPC shell (UI-RPC-01)
// ---------------------------------------------------------------------------

export function decodedJsonBytes(value) {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
}

export function validateRpcRequestV1(value, path = 'request') {
  object(value, path);
  keys(value, path, {required: ['schema_version', 'operation_id', 'context_ref', 'expected_scope_generation', 'view_epoch', 'input']});
  if (value.schema_version !== SCHEMA_VERSION) fail('INVALID_VALUE', `${path}.schema_version`, `must be ${SCHEMA_VERSION}`);
  string(value.operation_id, `${path}.operation_id`, {max: LIMITS.max_short_text});
  assertStableId(value.context_ref, `${path}.context_ref`);
  integer(value.expected_scope_generation, `${path}.expected_scope_generation`, {min: 1});
  integer(value.view_epoch, `${path}.view_epoch`, {min: 0});
  object(value.input, `${path}.input`);
  const size = decodedJsonBytes(value);
  if (size > LIMITS.max_request_bytes) fail('LIMIT_EXCEEDED', path, `decoded JSON exceeds ${LIMITS.max_request_bytes} bytes`);
  return value;
}

export function validateBusinessResponseV1(value, path = 'response') {
  object(value, path);
  keys(value, path, {required: ['schema_version', 'operation_id', 'view_epoch', 'scope_generation', 'status'], optional: ['data', 'reason_code']});
  if (value.schema_version !== SCHEMA_VERSION) fail('INVALID_VALUE', `${path}.schema_version`, `must be ${SCHEMA_VERSION}`);
  string(value.operation_id, `${path}.operation_id`, {max: LIMITS.max_short_text});
  integer(value.view_epoch, `${path}.view_epoch`, {min: 0});
  integer(value.scope_generation, `${path}.scope_generation`, {min: 1});
  oneOf(value.status, `${path}.status`, BUSINESS_STATUSES);
  if (value.status === 'ok') {
    if (!('data' in value)) fail('MISSING_FIELD', `${path}.data`, 'success responses must carry data');
    if ('reason_code' in value) fail('UNKNOWN_FIELD', `${path}.reason_code`, 'success responses must not carry reason_code');
  } else {
    if ('data' in value) fail('UNKNOWN_FIELD', `${path}.data`, 'failure responses must not carry data');
    if (!('reason_code' in value)) fail('MISSING_FIELD', `${path}.reason_code`, 'failure responses must carry reason_code');
    assertReasonCode(value.reason_code, `${path}.reason_code`);
  }
  const size = decodedJsonBytes(value);
  if (size > LIMITS.max_response_bytes) fail('LIMIT_EXCEEDED', path, `decoded JSON exceeds ${LIMITS.max_response_bytes} bytes`);
  return value;
}

// ---------------------------------------------------------------------------
// Canonical digests
// ---------------------------------------------------------------------------

function canonical(value, path) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_VALUE', path, 'non-finite numbers are not canonical');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item, index) => canonical(item, `${path}[${index}]`)).join(',')}]`;
  if (type === 'object') {
    const entries = Object.keys(value).sort();
    return `{${entries.map((key) => `${JSON.stringify(key)}:${canonical(value[key], `${path}.${key}`)}`).join(',')}}`;
  }
  fail('INVALID_VALUE', path, `cannot canonicalize ${type}`);
}

/** Deterministic JSON used for composition/policy digests. */
export function canonicalJson(value) {
  return canonical(value, '$');
}

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Digest of the canonical form; absolute paths and secrets must not be present. */
export function digestOf(value) {
  return sha256Hex(canonicalJson(value));
}

export function assertDiagnosticCount(diagnostics, path = 'diagnostics') {
  if (diagnostics.length > LIMITS.max_diagnostics) fail('LIMIT_EXCEEDED', path, `max ${LIMITS.max_diagnostics} diagnostics`);
}

/** Extract fixed reason code from an unknown thrown value; never expose its message. */
export function reasonCodeOf(error, fallback = 'INTERNAL_FAILURE') {
  if (error instanceof ContractError) {
    // Semantic circuit codes (STALE_SCOPE, EXPIRED_INTENT, ...) survive; plain
    // shape violations collapse to the fixed INVALID_REQUEST code.
    return REASON_CODE_SET.has(error.code) ? error.code : 'INVALID_REQUEST';
  }
  if (error && typeof error === 'object' && typeof error.code === 'string' && REASON_CODE_SET.has(error.code)) return error.code;
  return fallback;
}
