// Module registry: catalog ownership, single-owner descriptors, and the
// per-scope status aggregation the UI polls (design §4,§5,§9, UI-05).
//
// One descriptor per module id. Status listeners are registered once per
// (context_ref, scope_generation), never once per client; the aggregate
// revision increases on every accepted status change. Invalid descriptor
// output is downgraded to a blocked card, never passed through to the UI.
import {
  LIMITS,
  MODULE_STATES,
  ContractError,
  validateDiagnostic,
  validateModuleDescriptorV1,
  validateModuleManifest,
  validateModuleStatusV1,
  validateTrustedContext,
} from './contracts.mjs';

const STATUS_TTL_MS = 5000;

function blockedStatus(trusted, moduleId, reasonCode, nowIso) {
  return {
    schema_version: 1,
    module_id: moduleId,
    scope_ref: trusted.scope_ref,
    session_ref: trusted.session_ref,
    generation: trusted.scope_generation,
    revision: 0,
    state: 'blocked',
    reason_code: reasonCode,
    active_operations: [],
    updated_at: nowIso,
    capabilities: [],
  };
}

function makeDiagnostic(code, severity, moduleIds, resourceRef, messageKey, evidenceRef) {
  const diagnostic = {
    code,
    severity,
    module_ids: moduleIds.slice(0, 8),
    resource_ref: resourceRef,
    message_key: messageKey,
  };
  if (evidenceRef !== undefined) diagnostic.evidence_ref = evidenceRef;
  return validateDiagnostic(diagnostic);
}

export function createRegistry({catalog, now = () => Date.now(), ttlMs = STATUS_TTL_MS} = {}) {
  if (!Array.isArray(catalog)) throw new TypeError('registry catalog must be an array');
  const manifests = new Map();
  for (const rawManifest of catalog) {
    const manifest = validateModuleManifest(rawManifest);
    if (manifests.has(manifest.id)) throw new ContractError('INVALID_VALUE', `catalog.${manifest.id}`, 'duplicate module manifest id');
    manifests.set(manifest.id, manifest);
  }

  const descriptors = new Map();
  const diagnostics = [];
  const scopes = new Map();
  let revision = 0;
  let composition = {ordered: [], composition_digest: null};
  let disposed = false;

  function nowIso() {
    return new Date(now()).toISOString();
  }

  function bump() {
    revision += 1;
  }

  function addDiagnostic(diagnostic) {
    diagnostics.push(validateDiagnostic(diagnostic));
    if (diagnostics.length > LIMITS.max_diagnostics) diagnostics.shift();
    bump();
  }

  function clearDiagnostics(code) {
    for (let index = diagnostics.length - 1; index >= 0; index -= 1) if (diagnostics[index].code === code) diagnostics.splice(index, 1);
  }

  function scopeRecord(trusted, contextRef) {
    let record = scopes.get(contextRef);
    if (record === undefined || record.generation !== trusted.scope_generation) {
      if (record !== undefined) disposeScopeRecord(record);
      record = {generation: trusted.scope_generation, subscriptions: new Map(), statuses: new Map(), inflight: new Map(), contextRef};
      scopes.set(contextRef, record);
    }
    return record;
  }

  function disposeScopeRecord(record) {
    for (const subscription of record.subscriptions.values()) {
      try {
        subscription.dispose();
      } catch {
        // A failing disposer must not block other cleanups.
      }
    }
    record.subscriptions.clear();
    record.statuses.clear();
    record.inflight.clear();
  }

  function checkStatus(trusted, moduleId, rawStatus) {
    let status;
    try {
      status = validateModuleStatusV1(rawStatus);
    } catch {
      return {ok: false, diagnostic: makeDiagnostic('DESCRIPTOR_STATUS_INVALID', 'error', [moduleId], null, 'workbench.diagnostic.status_invalid'), status: blockedStatus(trusted, moduleId, 'INTERNAL_FAILURE', nowIso())};
    }
    if (status.module_id !== moduleId || status.scope_ref !== trusted.scope_ref || status.generation !== trusted.scope_generation) {
      return {ok: false, diagnostic: makeDiagnostic('DESCRIPTOR_SCOPE_MISMATCH', 'error', [moduleId], null, 'workbench.diagnostic.scope_mismatch'), status: blockedStatus(trusted, moduleId, 'STALE_SCOPE', nowIso())};
    }
    return {ok: true, status};
  }

  function acceptStatus(trusted, moduleId, rawStatus, record) {
    const checked = checkStatus(trusted, moduleId, rawStatus);
    const previous = record.statuses.get(moduleId);
    record.statuses.set(moduleId, {status: checked.status, at: now()});
    if (!checked.ok) {
      clearDiagnostics('DESCRIPTOR_STATUS_INVALID');
      clearDiagnostics('DESCRIPTOR_SCOPE_MISMATCH');
      addDiagnostic(checked.diagnostic);
      return checked;
    }
    if (previous === undefined || previous.status.revision !== checked.status.revision || previous.status.state !== checked.status.state) bump();
    return checked;
  }

  function ensureSubscriptions(trusted, contextRef, record, moduleIds) {
    for (const moduleId of moduleIds) {
      if (record.subscriptions.has(moduleId)) continue;
      const descriptor = descriptors.get(moduleId);
      if (descriptor === undefined) continue;
      let disposer;
      try {
        disposer = descriptor.subscribe(trusted, (rawStatus) => {
          if (disposed || scopes.get(contextRef) !== record) return;
          acceptStatus(trusted, moduleId, rawStatus, record);
        });
      } catch {
        addDiagnostic(makeDiagnostic('DESCRIPTOR_SUBSCRIBE_FAILED', 'error', [moduleId], null, 'workbench.diagnostic.subscribe_failed'));
        record.subscriptions.set(moduleId, {dispose() {}});
        continue;
      }
      if (typeof disposer !== 'function') throw new ContractError('INVALID_VALUE', `descriptor.${moduleId}.subscribe`, 'subscribe must return a disposer function');
      record.subscriptions.set(moduleId, {
        dispose: () => {
          try {
            disposer();
          } catch {
            // ignored: descriptor cleanup failure is surfaced by dispose tests, not the UI
          }
        },
      });
    }
  }

  async function refresh(trusted, contextRef, record, moduleIds) {
    const pending = [];
    for (const moduleId of moduleIds) {
      const descriptor = descriptors.get(moduleId);
      if (descriptor === undefined) continue;
      const cached = record.statuses.get(moduleId);
      const stale = cached === undefined || now() - cached.at > ttlMs;
      if (!stale) continue;
      let promise = record.inflight.get(moduleId);
      if (promise === undefined) {
        promise = Promise.resolve()
          .then(() => descriptor.getStatus(trusted))
          .then((rawStatus) => acceptStatus(trusted, moduleId, rawStatus, record))
          .catch(() => addDiagnostic(makeDiagnostic('DESCRIPTOR_STATUS_FAILED', 'error', [moduleId], null, 'workbench.diagnostic.status_failed')))
          .finally(() => record.inflight.delete(moduleId));
        record.inflight.set(moduleId, promise);
      }
      pending.push(promise);
    }
    if (pending.length > 0) await Promise.all(pending);
  }

  /**
   * Register a live descriptor. Model/external JSON can never register one:
   * the in-process function shape is validated here and ownership is single.
   */
  function registerDescriptor(rawDescriptor) {
    if (disposed) throw new ContractError('INVALID_STATE', 'registry', 'registry is disposed');
    const descriptor = validateModuleDescriptorV1(rawDescriptor);
    const manifest = manifests.get(descriptor.id);
    if (manifest === undefined) throw new ContractError('INVALID_VALUE', 'descriptor.id', 'descriptor id is not in the locked catalog');
    if (descriptors.has(descriptor.id)) throw new ContractError('ALREADY_OWNED', `descriptor.${descriptor.id}`, 'module already has an owner descriptor');
    if (descriptor.entry.kind !== manifest.entry.kind || descriptor.entry.ref !== manifest.entry.ref) {
      throw new ContractError('INVALID_VALUE', 'descriptor.entry', 'descriptor entry must match the locked manifest');
    }
    if (descriptor.release_version !== manifest.release_version) {
      throw new ContractError('INVALID_VALUE', 'descriptor.release_version', 'descriptor release must match the locked manifest');
    }
    descriptors.set(descriptor.id, descriptor);
    for (const record of scopes.values()) record.subscriptions.get(descriptor.id)?.dispose();
    bump();
    return () => {
      if (descriptors.get(descriptor.id) !== descriptor) return;
      descriptors.delete(descriptor.id);
      for (const record of scopes.values()) {
        record.subscriptions.get(descriptor.id)?.dispose();
        record.subscriptions.delete(descriptor.id);
        record.statuses.delete(descriptor.id);
      }
      bump();
    };
  }

  function setComposition({ordered, composition_digest: digest}) {
    if (!Array.isArray(ordered) || ordered.length > LIMITS.max_manifests) throw new ContractError('INVALID_VALUE', 'composition.ordered', 'must be a bounded module id array');
    for (const id of ordered) if (!manifests.has(id)) throw new ContractError('INVALID_VALUE', 'composition.ordered', `unknown module ${id}`);
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new ContractError('INVALID_VALUE', 'composition.composition_digest', 'must be a sha256 digest');
    composition = {ordered: ordered.slice(), composition_digest: digest};
    bump();
  }

  async function snapshot(trustedRaw, {after_revision = null, context_ref: contextRef = trustedRaw.caller_ref} = {}) {
    if (disposed) throw new ContractError('INVALID_STATE', 'registry', 'registry is disposed');
    const trusted = validateTrustedContext(trustedRaw);
    if (after_revision !== null && (!Number.isSafeInteger(after_revision) || after_revision < 0)) {
      throw new ContractError('INVALID_VALUE', 'after_revision', 'must be a non-negative integer');
    }
    if (after_revision === revision) return {changed: false, revision, modules: [], diagnostics: []};
    const record = scopeRecord(trusted, contextRef);
    const moduleIds = composition.ordered.length > 0 ? composition.ordered : [...manifests.keys()];
    ensureSubscriptions(trusted, contextRef, record, moduleIds);
    await refresh(trusted, contextRef, record, moduleIds);
    const modules = [];
    for (const moduleId of moduleIds) {
      const descriptor = descriptors.get(moduleId);
      const cached = record.statuses.get(moduleId);
      if (descriptor === undefined) {
        modules.push(blockedStatus(trusted, moduleId, 'NOT_READY', nowIso()));
        continue;
      }
      modules.push(cached === undefined ? blockedStatus(trusted, moduleId, 'NOT_READY', nowIso()) : cached.status);
    }
    return {changed: true, revision, modules, diagnostics: diagnostics.slice(0, LIMITS.max_diagnostics)};
  }

  function catalogEntry(moduleId) {
    return manifests.get(moduleId) ?? null;
  }

  function descriptorFor(moduleId) {
    return descriptors.get(moduleId) ?? null;
  }

  function moduleIds() {
    return [...manifests.keys()];
  }

  function allowedFrom(context, requested) {
    const allowed = new Set(context.allowed_module_ids);
    return requested === undefined ? [...allowed].filter((id) => manifests.has(id)) : allowed.has(requested) && manifests.has(requested) ? [requested] : [];
  }

  function compositionDigest() {
    return composition.composition_digest;
  }

  function compositionOrder() {
    return composition.ordered.slice();
  }

  function currentDiagnostics() {
    return diagnostics.slice(0, LIMITS.max_diagnostics);
  }

  async function quiesceModule(moduleId, signal) {
    const descriptor = descriptors.get(moduleId);
    if (descriptor === undefined) return {status: 'unknown', reason_code: 'NOT_READY'};
    if (!manifests.get(moduleId).dispose.supports_quiesce) return {status: 'idle'};
    let result;
    try {
      result = await descriptor.quiesce(signal);
    } catch {
      return {status: 'unknown', reason_code: 'QUIESCE_UNKNOWN'};
    }
    if (result === null || typeof result !== 'object' || !['idle', 'busy', 'unknown'].includes(result.status)) {
      return {status: 'unknown', reason_code: 'QUIESCE_UNKNOWN'};
    }
    return result;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const record of scopes.values()) disposeScopeRecord(record);
    scopes.clear();
    for (const descriptor of descriptors.values()) {
      try {
        descriptor.dispose();
      } catch {
        // Registry dispose must finish even when an owner fails to clean up.
      }
    }
    descriptors.clear();
    diagnostics.length = 0;
  }

  return {
    get revision() {
      return revision;
    },
    nowIso,
    moduleIds,
    catalogEntry,
    descriptorFor,
    registerDescriptor,
    setComposition,
    snapshot,
    allowedFrom,
    compositionDigest,
    compositionOrder,
    currentDiagnostics,
    quiesceModule,
    dispose,
    MODULE_STATES,
  };
}
