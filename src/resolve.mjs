// Composition solver for already locked local module catalogs (T2 / UI-02).
//
// The solver never installs, upgrades, downloads or auto-enables anything. It
// answers one question: given the pinned Host, an explicitly requested module
// set, the locked artifact digests, a local network policy and the local
// catalog, can those modules be assembled without ambiguity? Every "no" comes
// back as a deterministic diagnostic naming the owners involved.
import {
  LIMITS,
  PREFERRED_ORDER,
  ContractError,
  digestOf,
  isPlainObject,
  validateModuleManifest,
  validateResolveRequest,
  validateResolveResult,
} from './contracts.mjs';
import {checkModuleHostCompat} from './compat.mjs';
import {finalizeDiagnostics, inspectConflicts, makeDiagnostic, safeResourceRef} from './conflicts.mjs';

const PREFERRED_INDEX = new Map(PREFERRED_ORDER.map((id, index) => [id, index]));

function preferredCompare(left, right) {
  const leftIndex = PREFERRED_INDEX.get(left) ?? Number.MAX_SAFE_INTEGER;
  const rightIndex = PREFERRED_INDEX.get(right) ?? Number.MAX_SAFE_INTEGER;
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function insertSorted(list, value) {
  let index = 0;
  while (index < list.length && preferredCompare(list[index], value) <= 0) index += 1;
  list.splice(index, 0, value);
}

/**
 * Digest of the canonical composition identity: pinned host version plus the
 * ordered module id/sha pairs. Requested order never enters this value, so two
 * equivalent requests (or a re-run) produce the same digest.
 */
export function compositionDigest(hostVersion, orderedModules) {
  if (typeof hostVersion !== 'string') throw new ContractError('INVALID_TYPE', 'host_version', 'must be a string');
  if (!Array.isArray(orderedModules)) throw new ContractError('INVALID_TYPE', 'modules', 'must be an array');
  return digestOf({
    schema_version: 1,
    host_version: hostVersion,
    modules: orderedModules.map((module) => ({id: module.id, sha256: module.sha256})),
  });
}

function validateCatalog(catalog) {
  if (!Array.isArray(catalog)) throw new ContractError('INVALID_TYPE', 'catalog', 'must be an array of ModuleManifestV1');
  if (catalog.length > LIMITS.max_manifests) throw new ContractError('LIMIT_EXCEEDED', 'catalog', `max ${LIMITS.max_manifests} manifests`);
  catalog.forEach((manifest, index) => validateModuleManifest(manifest, `catalog[${index}]`));
  const byId = new Map();
  for (const manifest of catalog) {
    if (byId.has(manifest.id)) throw new ContractError('INVALID_VALUE', `catalog.${manifest.id}`, 'duplicate catalog module id');
    byId.set(manifest.id, manifest);
  }
  return byId;
}

/**
 * Network policy gate. A `none` policy rejects every module that would need any
 * target. When the manifest needs targets, every referenced target must already
 * be allow-listed locally; the tool never widens the policy on its own.
 */
function networkDiagnostics(manifest, policy) {
  const diagnostics = [];
  if (policy.network_mode === 'none') {
    if (manifest.network.mode !== 'none') {
      diagnostics.push(makeDiagnostic({
        code: 'NETWORK_POLICY',
        severity: 'error',
        module_ids: [manifest.id],
        resource_ref: safeResourceRef('module', manifest.id),
        message_key: 'resolve.network_rejected_by_none_policy',
      }));
    }
    return diagnostics;
  }
  if (manifest.network.mode === 'none') return diagnostics;
  const allowed = new Set(policy.allowed_target_refs ?? []);
  if (manifest.network.target_refs.some((ref) => !allowed.has(ref))) {
    diagnostics.push(makeDiagnostic({
      code: 'NETWORK_POLICY',
      severity: 'error',
      module_ids: [manifest.id],
      resource_ref: safeResourceRef('module', manifest.id),
      message_key: 'resolve.network_target_not_allowed',
    }));
  }
  return diagnostics;
}

/** Kahn topological sort with PREFERRED_ORDER tie-break; deterministic. */
function topologicalOrder(ids, dependencies) {
  const indegree = new Map(ids.map((id) => [id, 0]));
  const dependents = new Map(ids.map((id) => [id, []]));
  for (const id of ids) {
    for (const dependency of dependencies.get(id) ?? []) {
      if (!indegree.has(dependency)) continue; // missing deps are diagnosed separately
      indegree.set(id, indegree.get(id) + 1);
      dependents.get(dependency).push(id);
    }
  }
  const ready = ids.filter((id) => indegree.get(id) === 0).sort(preferredCompare);
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = indegree.get(dependent) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) insertSorted(ready, dependent);
    }
  }
  const ordered = new Set(order);
  const unresolved = ids.filter((id) => !ordered.has(id));
  return {order, unresolved};
}

export function resolveComposition(input) {
  if (!isPlainObject(input)) throw new ContractError('INVALID_TYPE', 'input', 'must be a plain object');
  const {host, requested_modules, locks, policy, catalog} = input;
  // Strict request validation reuses the shared v1 request contract.
  validateResolveRequest({host, requested_modules, locks, policy});
  const byId = validateCatalog(catalog);
  // Catalog entries are build-time data; every one must be a strict v1 manifest.

  const diagnostics = [];
  const disabled = [];
  const selected = new Map();

  // Deterministic processing order independent of caller request order.
  const requested = [...new Set(requested_modules)].sort(preferredCompare);

  for (const id of requested) {
    const manifest = byId.get(id);
    if (!manifest) {
      diagnostics.push(makeDiagnostic({
        code: 'UNKNOWN_MODULE',
        severity: 'error',
        module_ids: [id],
        resource_ref: safeResourceRef('module', id),
        message_key: 'resolve.module_not_in_catalog',
      }));
      continue;
    }
    const lockedDigest = locks[id];
    if (typeof lockedDigest !== 'string' || lockedDigest !== manifest.sha256) {
      diagnostics.push(makeDiagnostic({
        code: 'DIGEST_MISMATCH',
        severity: 'error',
        module_ids: [id],
        resource_ref: safeResourceRef('module', id),
        message_key: typeof lockedDigest === 'string' ? 'resolve.digest_mismatch' : 'resolve.lock_missing',
      }));
      continue;
    }
    const compat = checkModuleHostCompat(manifest, host.version);
    if (compat.status !== 'compatible') {
      diagnostics.push(makeDiagnostic({
        code: 'HOST_INCOMPATIBLE',
        severity: 'error',
        module_ids: [id],
        resource_ref: safeResourceRef('module', id),
        message_key: 'resolve.host_needs_verification',
      }));
      continue;
    }
    if (Array.isArray(policy.allowed_module_ids) && !policy.allowed_module_ids.includes(id)) {
      diagnostics.push(makeDiagnostic({
        code: 'MODULE_DENIED',
        severity: 'error',
        module_ids: [id],
        resource_ref: safeResourceRef('module', id),
        message_key: 'resolve.module_denied_by_policy',
      }));
      continue;
    }
    const network = networkDiagnostics(manifest, policy);
    if (network.length > 0) {
      diagnostics.push(...network);
      continue;
    }
    selected.set(id, manifest);
  }

  // Dependency edges and missing requirements. There is no implicit enabling.
  const dependencies = new Map([...selected.keys()].map((id) => [id, new Set()]));
  for (const [id, manifest] of selected) {
    for (const requirement of manifest.requires) {
      const dependencyId = requirement.module_id;
      if (dependencyId === '08') {
        // 08 is the composer, never a module; a manifest may not depend on it.
        diagnostics.push(makeDiagnostic({
          code: 'DEPENDENCY_MISSING',
          severity: 'error',
          module_ids: [id],
          resource_ref: safeResourceRef('module', dependencyId),
          message_key: 'resolve.dependency_on_composer',
        }));
        continue;
      }
      if (selected.has(dependencyId)) {
        dependencies.get(id).add(dependencyId);
        continue;
      }
      if (requirement.optional) {
        const optional = makeDiagnostic({
          code: 'DEPENDENCY_MISSING',
          severity: 'warning',
          module_ids: [id, dependencyId],
          resource_ref: safeResourceRef('module', dependencyId),
          message_key: 'resolve.optional_dependency_missing',
        });
        // The dependent feature subset stays off; the module is never fetched.
        disabled.push(optional);
        diagnostics.push(optional);
      } else {
        diagnostics.push(makeDiagnostic({
          code: 'DEPENDENCY_MISSING',
          severity: 'error',
          module_ids: [id, dependencyId],
          resource_ref: safeResourceRef('module', dependencyId),
          message_key: 'resolve.required_dependency_missing',
        }));
      }
    }
  }

  const selectedIds = [...selected.keys()].sort(preferredCompare);
  const topo = topologicalOrder(selectedIds, dependencies);
  if (topo.unresolved.length > 0) {
    diagnostics.push(makeDiagnostic({
      code: 'DEPENDENCY_CYCLE',
      severity: 'error',
      module_ids: topo.unresolved,
      resource_ref: null,
      message_key: 'resolve.dependency_cycle',
    }));
  }

  // Conflict inspection runs on the selected manifests only; unselected modules
  // can neither enable nor block this composition.
  const selectedManifests = selectedIds.map((id) => selected.get(id));
  diagnostics.push(...inspectConflicts(selectedManifests));

  const blocked = diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  const status = blocked ? 'blocked' : 'valid';
  const ordered = blocked ? [] : [...topo.order];
  const enabled = blocked ? [] : [...topo.order];

  // Digest identity is computed from the deterministic module id/sha sequence.
  // A blocked result still reports a stable digest of the gated candidate set so
  // callers can compare attempts without pretending the composition is valid.
  const digestIds = blocked ? selectedIds : topo.order;
  const digestModules = digestIds.map((id) => ({id, sha256: selected.get(id).sha256}));

  const result = {
    status,
    enabled,
    disabled: finalizeDiagnostics(disabled),
    ordered,
    composition_digest: compositionDigest(host.version, digestModules),
    diagnostics: finalizeDiagnostics(diagnostics),
  };
  return validateResolveResult(result);
}
