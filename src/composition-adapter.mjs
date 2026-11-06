// Composition service adapter: bridges the RPC composition endpoints to the
// scratch profile store + resolver (T3 consumed by T4).
//
// First version is scratch-only and never claims `active` without a real boot:
// the store's default verifier re-reads bytes and returns `restart_required`.
import {HOST_BASELINE, ContractError, REASON_CODES, validateDiagnostic} from './contracts.mjs';
import {createProfileStore, diffBetween} from './profile-store.mjs';
import {resolveProfileStoreRoot} from './host-rc5.mjs';

const ENDPOINT_STATUSES = new Set(['active', 'stale', 'denied', 'restart_required', 'rolled_back', 'partial', 'outcome_unknown']);

function reasonFrom(diagnostics, fallback = 'DIAGNOSTIC_ERROR') {
  for (const diagnostic of diagnostics ?? []) {
    if (diagnostic?.severity === 'error' && typeof diagnostic.code === 'string' && REASON_CODES.includes(diagnostic.code)) return diagnostic.code;
  }
  return fallback;
}

function normalizeDiff(diff) {
  const pickIds = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []);
  const changed = Array.isArray(diff?.changed)
    ? diff.changed
        .filter((row) => row !== null && typeof row === 'object' && typeof row.id === 'string')
        .map((row) => ({id: row.id, before: row.before ?? null, after: row.after ?? null}))
    : [];
  return {added: pickIds(diff?.added), removed: pickIds(diff?.removed), changed, unchanged: pickIds(diff?.unchanged)};
}

function normalizeStatus(status) {
  if (ENDPOINT_STATUSES.has(status)) return status;
  if (status === 'no_change' || status === 'prepared' || status === 'recovered') return status === 'no_change' ? 'active' : 'restart_required';
  if (status === 'failed' || status === 'cancelled') return 'outcome_unknown';
  return 'partial';
}

function sanitizeDiagnostics(diagnostics) {
  const out = [];
  for (const diagnostic of diagnostics ?? []) {
    try {
      out.push(validateDiagnostic(diagnostic));
    } catch {
      // Never echo malformed diagnostics from the composition layer.
    }
    if (out.length >= 50) break;
  }
  return out;
}

function displayForContext(config, trusted) {
  const row = config.contexts.find((context) => context.access.context_ref === trusted.caller_ref);
  return row === undefined ? null : row.display;
}

/**
 * Create the composition adapter, or undefined when the config has no scratch
 * profile store (composition endpoints then report PROFILE_NOT_FOUND).
 */
export async function createCompositionAdapter({config, dshHome, now = () => Date.now(), createStore = createProfileStore} = {}) {
  if (config.profile_store === undefined) return undefined;
  const resolvedRoot = resolveProfileStoreRoot({config, dshHome});
  const store = createStore({root: resolvedRoot.root, profile_id: resolvedRoot.profile_id, now});
  const host = {
    version: HOST_BASELINE.version,
    app_asar_sha256: HOST_BASELINE.app_asar_sha256,
    executable_sha256: HOST_BASELINE.executable_sha256,
  };
  const policy = {network_mode: 'none', allowed_module_ids: config.catalog.modules.map((manifest) => manifest.id)};
  let currentProfile = null;
  try {
    currentProfile = store.loadCurrent();
  } catch {
    currentProfile = null;
  }

  function ensureProfileRef(trusted, input) {
    const display = displayForContext(config, trusted);
    if (display === null || typeof input.profile_ref !== 'string' || input.profile_ref !== display.profile_ref) {
      throw new ContractError('PROFILE_DENIED', 'input.profile_ref', 'profile is not bound to this workbench context');
    }
    return display;
  }

  return {
    store,
    root: resolvedRoot,
    composition_digest: currentProfile?.composition_digest ?? null,
    profile_revision: currentProfile?.revision ?? null,
    async preview({trusted, input}) {
      ensureProfileRef(trusted, input);
      const prepared = store.prepare({
        selected_ids: input.selected_ids,
        expected_revision: input.expected_revision,
        catalog: config.catalog.modules,
        host,
        policy,
      });
      if (prepared.status !== 'prepared') {
        const reason = prepared.status === 'stale' ? 'STALE_REVISION' : reasonFrom(prepared.diagnostics);
        throw new ContractError(reason, 'composition.preview', 'composition preview was rejected');
      }
      return {
        preview_id: prepared.preview_id,
        diff: normalizeDiff(prepared.diff),
        composition_digest: prepared.composition_digest,
        expires_at: prepared.expires_at,
      };
    },
    async apply({trusted, input, operation_id: operationId}) {
      ensureProfileRef(trusted, input);
      const result = await store.apply(
        {preview_id: input.preview_id, expected_revision: input.expected_revision, operation_id: operationId},
        {},
      );
      return {
        status: normalizeStatus(result.status),
        revision: Number.isSafeInteger(result.revision) ? result.revision : 0,
        previous_revision: Number.isSafeInteger(result.previous_revision) ? result.previous_revision : 0,
        composition_digest: typeof result.composition_digest === 'string' ? result.composition_digest : '0'.repeat(64),
        diagnostics: sanitizeDiagnostics(result.diagnostics),
      };
    },
    recover(options = {}) {
      return store.recover(options);
    },
    close() {
      // The store holds no open handles (locks are acquired per operation).
    },
  };
}

// Re-exported for tests that need the pure diff helper without the store.
export {diffBetween};
