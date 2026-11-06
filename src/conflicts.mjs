// Conflict detection over already validated ModuleManifestV1 objects (T2 / UI-02).
//
// The v1 manifest is the only evidence available here: it names tools, slots,
// writers and hooks, but it cannot prove two dynamic scopes are disjoint and it
// cannot prove a hook observer is transparent. That is why writer and hook
// conflicts are deliberately conservative: they block the composition instead
// of betting on unproven disjointness. Conflict resolution is a product change
// (drop a module or amend its owner contract), never "last loaded wins".
import {LIMITS, ContractError, assertRef, validateDiagnostic, validateModuleManifest} from './contracts.mjs';

const SEVERITY_RANK = Object.freeze({error: 0, warning: 1, info: 2});

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Manifest v1 gives no field that could prove two writers disjoint: `scope`
 * is a coarse enum (`global`/`scope`/`session`) with no scope identity. So the
 * only honest answer for two writers of the same resource is "potentially
 * intersecting". Global intersects everything; the remaining combinations are
 * treated the same way. A future major schema could add a disjointness proof
 * token, but no unverified heuristic is invented here.
 */
export function writerScopesIntersect(left, right) {
  if (left === 'global' || right === 'global') return true;
  return true;
}

/** Resource refs are diagnostic labels; they must satisfy assertRef, else null. */
export function safeResourceRef(kind, ...parts) {
  const raw = [kind, ...parts.map((part) => String(part))].join('/');
  try {
    assertRef(raw, 'resource_ref');
    return raw;
  } catch {
    return null;
  }
}

/** Unique, bounded (validator max 8) and sorted module id list for diagnostics. */
export function moduleIdList(ids) {
  return [...new Set(ids)].sort(compareText).slice(0, 8);
}

//
// Deterministic diagnostic construction / ordering.
//
export function makeDiagnostic({code, severity, module_ids = [], resource_ref = null, message_key, evidence_ref}) {
  const diagnostic = {
    code,
    severity,
    module_ids: moduleIdList(module_ids),
    resource_ref,
    message_key,
  };
  if (evidence_ref !== undefined) diagnostic.evidence_ref = evidence_ref;
  validateDiagnostic(diagnostic, 'diagnostic');
  return diagnostic;
}

/** Sorted so two runs (or shuffled catalogs) produce byte-identical lists. */
export function sortDiagnostics(diagnostics) {
  return [...diagnostics].sort((left, right) => (
    (SEVERITY_RANK[left.severity] ?? 9) - (SEVERITY_RANK[right.severity] ?? 9)
    || compareText(left.code, right.code)
    || compareText(left.message_key, right.message_key)
    || compareText(left.resource_ref ?? '', right.resource_ref ?? '')
    || compareText(left.module_ids.join(','), right.module_ids.join(','))
  ));
}

/** Sort then enforce the 1000 diagnostic cap from the v1 limits. */
export function finalizeDiagnostics(diagnostics) {
  return sortDiagnostics(diagnostics).slice(0, LIMITS.max_diagnostics);
}

//
// Conflict inspection.
//
export function inspectConflicts(manifests) {
  if (!Array.isArray(manifests)) throw new ContractError('INVALID_TYPE', 'manifests', 'must be an array');
  manifests.forEach((manifest, index) => validateModuleManifest(manifest, `manifests[${index}]`));

  const diagnostics = [];
  const tools = new Map(); // name -> module ids
  const slots = []; // {module_id, name, key, mode}
  const writers = new Map(); // resource -> module ids
  const hooks = new Map(); // name -> {observe: [], exclusive: []}

  for (const manifest of manifests) {
    for (const tool of manifest.provides.tools) {
      const owners = tools.get(tool.name) ?? [];
      owners.push(manifest.id);
      tools.set(tool.name, owners);
    }
    for (const slot of manifest.provides.slots) {
      slots.push({module_id: manifest.id, name: slot.name, key: slot.key, mode: slot.mode});
    }
    for (const writer of manifest.provides.writers) {
      const owners = writers.get(writer.resource) ?? [];
      owners.push({module_id: manifest.id, scope: writer.scope});
      writers.set(writer.resource, owners);
    }
    for (const hook of manifest.provides.hooks) {
      const bucket = hooks.get(hook.name) ?? {observe: [], exclusive: []};
      if (hook.mode === 'exclusive_mutate') bucket.exclusive.push(manifest.id);
      else bucket.observe.push(manifest.id);
      hooks.set(hook.name, bucket);
    }
  }

  // Tool names are Host-global: exactly one owner may register a name.
  for (const [name, owners] of tools) {
    if (owners.length < 2) continue;
    diagnostics.push(makeDiagnostic({
      code: 'TOOL_CONFLICT',
      severity: 'error',
      module_ids: owners,
      resource_ref: safeResourceRef('tool', name),
      message_key: 'conflict.tool_duplicate',
    }));
  }

  // Slots: a `single` slot owns its whole name; `keyed`/`list` slots may share
  // a name only across distinct keys, and one name may not mix modes.
  const slotsByName = new Map();
  for (const slot of slots) {
    const group = slotsByName.get(slot.name) ?? [];
    group.push(slot);
    slotsByName.set(slot.name, group);
  }
  for (const [name, group] of slotsByName) {
    if (group.length < 2) continue;
    const modes = new Set(group.map((entry) => entry.mode));
    const moduleIds = group.map((entry) => entry.module_id);
    if (modes.size > 1) {
      diagnostics.push(makeDiagnostic({
        code: 'SLOT_CONFLICT',
        severity: 'error',
        module_ids: moduleIds,
        resource_ref: safeResourceRef('slot', name),
        message_key: 'conflict.slot_mode_mismatch',
      }));
      continue;
    }
    const mode = group[0].mode;
    if (mode === 'single') {
      diagnostics.push(makeDiagnostic({
        code: 'SLOT_CONFLICT',
        severity: 'error',
        module_ids: moduleIds,
        resource_ref: safeResourceRef('slot', name),
        message_key: 'conflict.slot_single_duplicate',
      }));
      continue;
    }
    // keyed / list: duplicate name+key is a conflict, distinct keys coexist.
    const byKey = new Map();
    for (const entry of group) {
      const key = entry.key ?? '<null>';
      const bucket = byKey.get(key) ?? [];
      bucket.push(entry.module_id);
      byKey.set(key, bucket);
    }
    for (const [key, owners] of byKey) {
      if (owners.length < 2) continue;
      diagnostics.push(makeDiagnostic({
        code: 'SLOT_CONFLICT',
        severity: 'error',
        module_ids: owners,
        resource_ref: key === '<null>' ? safeResourceRef('slot', name) : safeResourceRef('slot', name, key),
        message_key: mode === 'keyed' ? 'conflict.slot_keyed_key_duplicate' : 'conflict.slot_list_key_duplicate',
      }));
    }
  }

  // Writers: overlapping scope over the same resource keeps two owners.
  for (const [resource, owners] of writers) {
    if (owners.length < 2) continue;
    let intersecting = false;
    for (let left = 0; left < owners.length && !intersecting; left += 1) {
      for (let right = left + 1; right < owners.length && !intersecting; right += 1) {
        if (writerScopesIntersect(owners[left].scope, owners[right].scope)) intersecting = true;
      }
    }
    if (!intersecting) continue;
    diagnostics.push(makeDiagnostic({
      code: 'WRITER_CONFLICT',
      severity: 'error',
      module_ids: owners.map((owner) => owner.module_id),
      resource_ref: safeResourceRef('writer', resource),
      message_key: 'conflict.writer_resource_shared',
    }));
  }

  // Hooks: two exclusive_mutate owners of one hook name conflict. Observe hooks
  // are allowed to coexist (informational only; they must still prove
  // transparency/dispose in their release evidence).
  for (const [name, bucket] of hooks) {
    const total = bucket.observe.length + bucket.exclusive.length;
    if (bucket.exclusive.length >= 2) {
      diagnostics.push(makeDiagnostic({
        code: 'HOOK_CONFLICT',
        severity: 'error',
        module_ids: bucket.exclusive,
        resource_ref: safeResourceRef('hook', name),
        message_key: 'conflict.hook_exclusive_mutate_duplicate',
      }));
      continue;
    }
    if (bucket.exclusive.length === 0 && total >= 2) {
      diagnostics.push(makeDiagnostic({
        code: 'OBSERVE_COEXIST',
        severity: 'info',
        module_ids: bucket.observe,
        resource_ref: safeResourceRef('hook', name),
        message_key: 'conflict.observe_hooks_coexist',
      }));
    }
  }

  return finalizeDiagnostics(diagnostics);
}
