// Local trusted access registry (design §6, UI-RPC-01).
//
// The browser session shares the Host's owner Peer, so "owner" alone is not a
// project permission. A context must have been registered locally first; the
// client can only name context_ref values returned by context.list, and the
// Host re-checks generation/association before any descriptor sees the scope.
import {LIMITS, ContractError, validateAccessRegistryV1, validateTrustedContext, assertStableId, assertRef} from './contracts.mjs';

function fail(code, path, message) {
  return new ContractError(code, path, message);
}

export function validateContextDisplay(value, path = 'display') {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw fail('INVALID_TYPE', path, 'must be a plain object');
  const allowed = ['label', 'context_revision', 'profile_ref', 'profile_revision', 'selected_module_ids'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw fail('UNKNOWN_FIELD', `${path}.${key}`, 'unknown field is rejected');
  for (const key of allowed) if (!(key in value)) throw fail('MISSING_FIELD', `${path}.${key}`, 'required display field is missing');
  if (typeof value.label !== 'string' || value.label.trim() === '' || value.label.length > LIMITS.max_short_text) throw fail('INVALID_VALUE', `${path}.label`, 'must be a short label');
  if (typeof value.context_revision !== 'string' || value.context_revision.length === 0 || value.context_revision.length > LIMITS.max_short_text) throw fail('INVALID_VALUE', `${path}.context_revision`, 'must be a revision reference');
  assertRef(value.profile_ref, `${path}.profile_ref`);
  if (!Number.isSafeInteger(value.profile_revision) || value.profile_revision < 0) throw fail('INVALID_VALUE', `${path}.profile_revision`, 'must be a non-negative integer');
  if (!Array.isArray(value.selected_module_ids) || value.selected_module_ids.length > LIMITS.max_manifests) throw fail('INVALID_VALUE', `${path}.selected_module_ids`, 'must be a bounded module id array');
  value.selected_module_ids.forEach((id, index) => {
    if (typeof id !== 'string' || !/^0[1-7]$/.test(id)) throw fail('INVALID_VALUE', `${path}.selected_module_ids[${index}]`, 'must be a module id');
  });
  return value;
}

export function validateAccessRegistryInput(value, path = 'access') {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw fail('INVALID_TYPE', path, 'must be a plain object');
  const allowed = ['schema_version', 'revision', 'contexts', 'profile_refs', 'displays'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw fail('UNKNOWN_FIELD', `${path}.${key}`, 'unknown field is rejected');
  if (!('displays' in value)) throw fail('MISSING_FIELD', `${path}.displays`, 'display rows must be explicit');
  const base = {schema_version: value.schema_version, revision: value.revision, contexts: value.contexts, profile_refs: value.profile_refs};
  validateAccessRegistryV1(base, path);
  if (!Array.isArray(value.displays)) throw fail('INVALID_TYPE', `${path}.displays`, 'must be an array');
  const contextRefs = new Set(base.contexts.map((entry) => entry.context_ref));
  const displayRefs = new Set();
  value.displays.forEach((display, index) => {
    checkDisplay(display, `${path}.displays[${index}]`);
    if (!contextRefs.has(display.context_ref)) throw fail('INVALID_VALUE', `${path}.displays[${index}].context_ref`, 'display row has no matching access context');
    if (displayRefs.has(display.context_ref)) throw fail('INVALID_VALUE', `${path}.displays[${index}].context_ref`, 'duplicate display row');
    displayRefs.add(display.context_ref);
  });
  for (const ref of contextRefs) if (!displayRefs.has(ref)) throw fail('MISSING_FIELD', `${path}.displays`, `missing display row for ${ref}`);
  return value;
}

function checkDisplay(display, path) {
  if (typeof display !== 'object' || display === null || Array.isArray(display)) throw fail('INVALID_TYPE', path, 'must be a plain object');
  const allowed = ['context_ref', 'label', 'context_revision', 'profile_ref', 'profile_revision', 'selected_module_ids'];
  for (const key of Object.keys(display)) if (!allowed.includes(key)) throw fail('UNKNOWN_FIELD', `${path}.${key}`, 'unknown field is rejected');
  assertStableId(display.context_ref, `${path}.context_ref`);
  validateContextDisplay({
    label: display.label,
    context_revision: display.context_revision,
    profile_ref: display.profile_ref,
    profile_revision: display.profile_revision,
    selected_module_ids: display.selected_module_ids,
  }, path);
}

export const ACCESS_REASON = Object.freeze({
  okay: null,
  unbound: 'CONTEXT_UNBOUND',
  stale: 'STALE_SCOPE',
  revoked: 'SCOPE_REVOKED',
  profile: 'PROFILE_DENIED',
  owner: 'OWNER_REQUIRED',
});

/**
 * Create the local trusted access registry. `displays` carries only bounded,
 * non-secret presentation fields; it never widens permitted scopes.
 */
export function createAccessRegistry(input, {now = () => new Date().toISOString()} = {}) {
  const state = validateAccessRegistryInput(input);
  const contexts = new Map();
  for (const entry of state.contexts) contexts.set(entry.context_ref, {...entry});
  const displays = new Map();
  for (const display of state.displays) {
    const {context_ref: contextRef, ...rest} = display;
    displays.set(contextRef, {...rest});
  }
  let revision = state.revision;
  let profileRefs = state.profile_refs.slice();

  function contextRefs() {
    return [...contexts.keys()];
  }

  function listForOwner(peer) {
    if (!isOwnerPeer(peer)) return {ok: false, reason_code: ACCESS_REASON.owner};
    const rows = [];
    for (const entry of contexts.values()) {
      if (!entry.active) continue;
      const display = displays.get(entry.context_ref);
      rows.push({
        context_ref: entry.context_ref,
        scope_ref: entry.scope_ref,
        scope_generation: entry.scope_generation,
        session_ref: entry.session_ref,
        allowed_module_ids: entry.allowed_module_ids.slice(),
        label: display.label,
        context_revision: display.context_revision,
        profile_ref: display.profile_ref,
        profile_revision: display.profile_revision,
        selected_module_ids: display.selected_module_ids.slice(),
        active: entry.active,
      });
    }
    rows.sort((left, right) => left.context_ref.localeCompare(right.context_ref));
    return {ok: true, revision, contexts: rows, profile_refs: profileRefs.slice()};
  }

  /** Resolve a client-named context. A fabricated context_ref never resolves. */
  function resolve({context_ref: contextRef, expected_scope_generation: expectedGeneration}) {
    const entry = contexts.get(contextRef);
    if (entry === undefined) return {ok: false, reason_code: ACCESS_REASON.unbound};
    if (!entry.active) return {ok: false, reason_code: ACCESS_REASON.revoked};
    if (entry.scope_generation !== expectedGeneration) return {ok: false, reason_code: ACCESS_REASON.stale};
    return {ok: true, entry};
  }

  function toTrustedContext(entry) {
    const display = displays.get(entry.context_ref);
    const trusted = {
      scope_ref: entry.scope_ref,
      scope_generation: entry.scope_generation,
      session_ref: entry.session_ref,
      caller_ref: entry.context_ref,
      context_revision: display.context_revision,
    };
    return validateTrustedContext(trusted);
  }

  function allowedModuleIds(entry, requested) {
    const allowed = new Set(entry.allowed_module_ids);
    if (requested === undefined) return [...allowed];
    return allowed.has(requested) ? [requested] : [];
  }

  function profileAllowed(profileRef) {
    return profileRefs.includes(profileRef);
  }

  /** Trusted in-process registration (config load); never exposed on RPC. */
  function registerContext({access, display}) {
    const {context_ref: contextRef} = access;
    if (contexts.has(contextRef)) {
      const existing = contexts.get(contextRef);
      if (existing.scope_ref !== access.scope_ref || existing.session_ref !== access.session_ref) {
        throw fail('INVALID_VALUE', 'access.context_ref', 'a context_ref cannot be re-bound to another scope/session');
      }
    }
    validateAccessRegistryV1({schema_version: 1, revision, contexts: [access], profile_refs: profileRefs});
    validateContextDisplay(display, 'display');
    contexts.set(contextRef, {...access});
    const {context_ref: displayContextRef, ...rest} = display;
    displays.set(displayContextRef, {...rest});
    revision += 1;
    return {ok: true, revision};
  }

  function revokeContext(contextRef, {reason = 'SCOPE_REVOKED'} = {}) {
    const entry = contexts.get(contextRef);
    if (entry === undefined) return {ok: false, reason_code: ACCESS_REASON.unbound};
    entry.active = false;
    revision += 1;
    return {ok: true, revision, reason};
  }

  function replaceProfiles(refs) {
    profileRefs = refs.slice();
    revision += 1;
    return {ok: true, revision};
  }

  function snapshot() {
    return {
      schema_version: 1,
      revision,
      contexts: [...contexts.values()].map((entry) => ({...entry, allowed_module_ids: entry.allowed_module_ids.slice()})),
      profile_refs: profileRefs.slice(),
    };
  }

  function dispose() {
    contexts.clear();
    displays.clear();
    profileRefs = [];
  }

  /** Current context_revision for callers that need to compare intents. */
  function contextRevision(contextRef) {
    return displays.get(contextRef)?.context_revision ?? null;
  }

  return {
    get revision() {
      return revision;
    },
    get now() {
      return now();
    },
    listForOwner,
    resolve,
    toTrustedContext,
    allowedModuleIds,
    profileAllowed,
    registerContext,
    revokeContext,
    replaceProfiles,
    snapshot,
    contextRevision,
    dispose,
  };
}

export function isOwnerPeer(peer) {
  return typeof peer === 'object' && peer !== null && typeof peer.principal === 'object' && peer.principal !== null && peer.principal.kind === 'owner';
}

/** Load a strict access-registry JSON document from a file's text content. */
export function parseAccessRegistryJson(text, path = 'access.json') {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw fail('INVALID_JSON', path, `not valid JSON: ${String(error.message ?? error)}`);
  }
  return validateAccessRegistryInput(parsed, path);
}
