// rc.5 Host adapter: local config, fixture descriptors, service registration.
//
// This module binds the workbench to the pinned Host through the reviewed
// `ctx.connection.rpc.handle` seam. It never reads credentials, never starts a
// network client, and never treats a client receipt as business success. The
// first version only registers local, explicitly-fixture modules; 05/07 real
// releases remain a T5 gate.
import {existsSync, readFileSync} from 'node:fs';
import {isAbsolute, join, resolve, sep} from 'node:path';
import {
  HOST_BASELINE,
  LIMITS,
  MODULE_STATES,
  NETWORK_MODES,
  ACTIVE_OPERATION_STATES,
  ContractError,
  assertRef,
  assertReasonCode,
  assertStableId,
  digestOf,
  validateModuleManifest,
  validateModuleStatusV1,
} from './contracts.mjs';
import {createAccessRegistry, isOwnerPeer, validateAccessRegistryInput, validateContextDisplay} from './access.mjs';
import {createRegistry} from './registry.mjs';
import {createActionService} from './actions.mjs';
import {createRpcHandler} from './rpc.mjs';

export const CONFIG_SCHEMA_VERSION = 1;
export const CONFIG_RELATIVE_PATH = 'workbench/workbench.json';
export const PANEL_KEYS = Object.freeze({'05': 'local-memory', '07': 'local-context'});

const CONFIG_KEYS = ['schema_version', 'fixture_mode', 'profile_refs', 'catalog', 'contexts', 'profile_store', 'fixture_status'];
const FIXTURE_STATES = new Set(['ready', 'busy', 'attention', 'disabled', 'blocked', 'unavailable']);

function configObject(value, path) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ContractError('INVALID_TYPE', path, 'must be a plain object');
  return value;
}

function configKeys(value, path, allowed, required = allowed) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new ContractError('UNKNOWN_FIELD', `${path}.${key}`, 'unknown config field is rejected');
  for (const key of required) if (!(key in value)) throw new ContractError('MISSING_FIELD', `${path}.${key}`, 'required config field is missing');
}

function fixtureStatusRow(moduleId, value, path) {
  configObject(value, path);
  configKeys(value, path, ['state', 'reason_code', 'capabilities', 'active_operations'], ['state']);
  if (!FIXTURE_STATES.has(value.state)) throw new ContractError('INVALID_VALUE', `${path}.state`, 'must be a module state');
  const status = {
    schema_version: 1,
    module_id: moduleId,
    scope_ref: 'fixture/scope',
    session_ref: null,
    generation: 1,
    revision: 1,
    state: value.state,
    reason_code: value.reason_code ?? null,
    active_operations: value.active_operations ?? [],
    updated_at: new Date(0).toISOString(),
    capabilities: value.capabilities ?? ['fixture.capability'],
  };
  validateModuleStatusV1(status, path);
  return {
    state: status.state,
    reason_code: status.reason_code,
    capabilities: status.capabilities.slice(),
    active_operations: status.active_operations.map((operation) => ({...operation})),
  };
}

/** Strict WorkbenchConfigV1 (local file; no secrets, refs only). */
export function validateWorkbenchConfigV1(value, path = 'workbench-config') {
  configObject(value, path);
  configKeys(value, path, CONFIG_KEYS, ['schema_version', 'fixture_mode', 'profile_refs', 'catalog', 'contexts']);
  if (value.schema_version !== CONFIG_SCHEMA_VERSION) throw new ContractError('INVALID_VALUE', `${path}.schema_version`, `must be ${CONFIG_SCHEMA_VERSION}`);
  if (typeof value.fixture_mode !== 'boolean') throw new ContractError('INVALID_TYPE', `${path}.fixture_mode`, 'must be a boolean');
  if (!Array.isArray(value.profile_refs)) throw new ContractError('INVALID_TYPE', `${path}.profile_refs`, 'must be an array');
  value.profile_refs.forEach((ref, index) => assertRef(ref, `${path}.profile_refs[${index}]`));

  configObject(value.catalog, `${path}.catalog`);
  configKeys(value.catalog, `${path}.catalog`, ['catalog_ref', 'fixtures', 'modules']);
  assertRef(value.catalog.catalog_ref, `${path}.catalog.catalog_ref`);
  if (typeof value.catalog.fixtures !== 'boolean') throw new ContractError('INVALID_TYPE', `${path}.catalog.fixtures`, 'must be a boolean');
  if (!Array.isArray(value.catalog.modules) || value.catalog.modules.length === 0 || value.catalog.modules.length > LIMITS.max_manifests) {
    throw new ContractError('INVALID_VALUE', `${path}.catalog.modules`, `must hold 1..${LIMITS.max_manifests} manifests`);
  }
  const modules = value.catalog.modules.map((manifest, index) => validateModuleManifest(manifest, `${path}.catalog.modules[${index}]`));
  const ids = new Set(modules.map((manifest) => manifest.id));
  if (ids.size !== modules.length) throw new ContractError('INVALID_VALUE', `${path}.catalog.modules`, 'duplicate module id');
  for (const manifest of modules) {
    if (manifest.network.mode !== 'none') throw new ContractError('NETWORK_POLICY', `${path}.catalog.modules.${manifest.id}.network`, 'first-version workbench catalog must be no-network');
  }

  if (!Array.isArray(value.contexts) || value.contexts.length === 0 || value.contexts.length > 64) {
    throw new ContractError('INVALID_VALUE', `${path}.contexts`, 'must hold 1..64 registered contexts');
  }
  const accessContexts = [];
  const displays = [];
  const seen = new Set();
  value.contexts.forEach((context, index) => {
    const contextPath = `${path}.contexts[${index}]`;
    configObject(context, contextPath);
    configKeys(context, contextPath, ['access', 'display']);
    const access = configObject(context.access, `${contextPath}.access`);
    configKeys(access, `${contextPath}.access`, ['context_ref', 'scope_ref', 'scope_generation', 'session_ref', 'allowed_module_ids', 'active']);
    const display = configObject(context.display, `${contextPath}.display`);
    validateContextDisplay(display, `${contextPath}.display`);
    accessContexts.push({...access});
    displays.push({context_ref: access.context_ref, ...display});
    if (seen.has(access.context_ref)) throw new ContractError('INVALID_VALUE', `${contextPath}.access.context_ref`, 'duplicate context_ref');
    seen.add(access.context_ref);
    for (const moduleId of access.allowed_module_ids) {
      if (!ids.has(moduleId)) throw new ContractError('INVALID_VALUE', `${contextPath}.access.allowed_module_ids`, `module ${moduleId} is not in the catalog`);
    }
  });
  validateAccessRegistryInput({schema_version: 1, revision: 0, contexts: accessContexts, profile_refs: value.profile_refs, displays}, `${path}.contexts`);
  for (const context of value.contexts) {
    for (const moduleId of context.display.selected_module_ids) {
      if (!ids.has(moduleId)) throw new ContractError('INVALID_VALUE', `${path}.contexts.display.selected_module_ids`, `selected module ${moduleId} is not in the catalog`);
    }
  }

  if (value.profile_store !== undefined) {
    configObject(value.profile_store, `${path}.profile_store`);
    configKeys(value.profile_store, `${path}.profile_store`, ['root_ref', 'profile_id']);
    assertRef(value.profile_store.root_ref, `${path}.profile_store.root_ref`);
    if (value.profile_store.root_ref.split('/').includes('..')) throw new ContractError('PATH_UNTRUSTED', `${path}.profile_store.root_ref`, 'parent traversal is rejected');
    assertStableId(value.profile_store.profile_id, `${path}.profile_store.profile_id`);
    if (!value.fixture_mode) throw new ContractError('INVALID_VALUE', `${path}.profile_store`, 'first-version profile store is scratch-only and requires fixture_mode');
  }

  if (value.fixture_status !== undefined) {
    configObject(value.fixture_status, `${path}.fixture_status`);
    for (const [moduleId, row] of Object.entries(value.fixture_status)) {
      if (!ids.has(moduleId)) throw new ContractError('INVALID_VALUE', `${path}.fixture_status.${moduleId}`, 'module is not in the catalog');
      value.fixture_status[moduleId] = fixtureStatusRow(moduleId, row, `${path}.fixture_status.${moduleId}`);
    }
  }

  return value;
}

/**
 * Resolve the local config file: `DSH_WORKBENCH_CONFIG` (test/install
 * override, absolute) or `<dshHome>/workbench/workbench.json`.
 */
export function resolveConfigPath({dshHome, env = process.env} = {}) {
  if (typeof env.DSH_WORKBENCH_CONFIG === 'string' && env.DSH_WORKBENCH_CONFIG !== '') {
    if (!isAbsolute(env.DSH_WORKBENCH_CONFIG)) throw new ContractError('PATH_UNTRUSTED', 'DSH_WORKBENCH_CONFIG', 'must be an absolute local path');
    return resolve(env.DSH_WORKBENCH_CONFIG);
  }
  if (typeof dshHome !== 'string' || dshHome === '') return null;
  return join(resolve(dshHome), ...CONFIG_RELATIVE_PATH.split('/'));
}

export function loadWorkbenchConfig({dshHome, env = process.env} = {}) {
  const path = resolveConfigPath({dshHome, env});
  if (path === null || !existsSync(path)) return {ok: false, reason_code: 'PROFILE_NOT_FOUND', path: null, config: null};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {ok: false, reason_code: 'INVALID_REQUEST', path, config: null, detail: `config JSON is not parseable (${String(error.code ?? 'PARSE')})`};
  }
  try {
    return {ok: true, reason_code: null, path, config: validateWorkbenchConfigV1(parsed)};
  } catch (error) {
    const code = error instanceof ContractError ? error.code : 'INVALID_REQUEST';
    return {ok: false, reason_code: code === 'PATH_UNTRUSTED' ? 'PATH_UNTRUSTED' : 'INVALID_REQUEST', path, config: null, detail: error instanceof ContractError ? error.message : 'config validation failed'};
  }
}

/** Resolve the scratch profile-store root strictly under dshHome. */
export function resolveProfileStoreRoot({config, dshHome}) {
  if (config.profile_store === undefined) return null;
  if (typeof dshHome !== 'string' || dshHome === '') throw new ContractError('PATH_UNTRUSTED', 'dshHome', 'a local DSH_HOME is required for the profile store');
  const home = resolve(dshHome);
  const target = resolve(home, ...config.profile_store.root_ref.split('/'));
  if (target !== home && !target.startsWith(home + sep)) throw new ContractError('PATH_UNTRUSTED', 'profile_store.root_ref', 'store root escapes DSH_HOME');
  return {root: target, profile_id: config.profile_store.profile_id};
}

function fixturePanelKey(moduleId) {
  return PANEL_KEYS[moduleId] ?? `local-module-${moduleId}`;
}

/**
 * Build a descriptor for a fixture module. The status is deterministic and
 * always labeled fixture by the UI (`fixture_mode`); it never represents a real
 * installed module release.
 */
export function createFixtureDescriptor({manifest, status: statusOverride, compositionDigest = 'd'.repeat(64), now = () => Date.now()}) {
  const listeners = new Map();
  let base = statusOverride ?? {state: 'ready', reason_code: null, capabilities: ['fixture.capability'], active_operations: []};
  let revision = 1;

  function statusFor(trusted) {
    return {
      schema_version: 1,
      module_id: manifest.id,
      scope_ref: trusted.scope_ref,
      session_ref: trusted.session_ref,
      generation: trusted.scope_generation,
      revision,
      state: base.state,
      reason_code: base.reason_code,
      active_operations: base.active_operations,
      updated_at: new Date(now()).toISOString(),
      capabilities: base.capabilities.slice(),
    };
  }

  function emit(next) {
    base = {...base, ...next};
    revision += 1;
    for (const [listener, trusted] of listeners) {
      try {
        listener(statusFor(trusted));
      } catch {
        // Fixture listener failures are ignored; the registry replaces invalid rows.
      }
    }
  }

  return {
    contract_version: 1,
    id: manifest.id,
    release_version: manifest.release_version,
    entry: {kind: manifest.entry.kind, ref: manifest.entry.ref},
    getStatus(trusted) {
      return Promise.resolve(statusFor(trusted));
    },
    subscribe(trusted, listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.set(listener, trusted);
      return () => {
        listeners.delete(listener);
      };
    },
    planOpen(trusted) {
      const target = manifest.entry.kind === 'panel'
        ? {kind: 'panel', panel_key: fixturePanelKey(manifest.id)}
        : {
            kind: manifest.entry.kind,
            ...(manifest.entry.kind === 'skill' ? {skill_ref: manifest.entry.ref} : {command_ref: manifest.entry.ref}),
            instruction_key: `fixture.instruction.${manifest.id}`,
          };
      return Promise.resolve({
        schema_version: 1,
        intent_id: `intent-${manifest.id}-${trusted.scope_generation}-${now()}`,
        operation_id: `plan-${manifest.id}-${now()}`,
        owner_module: manifest.id,
        scope_ref: trusted.scope_ref,
        scope_generation: trusted.scope_generation,
        context_revision: trusted.context_revision,
        module_revision: 1,
        composition_digest: compositionDigest,
        expires_at: new Date(now() + 30000).toISOString(),
        target,
      });
    },
    quiesce() {
      return Promise.resolve({status: 'idle'});
    },
    dispose() {
      listeners.clear();
    },
    emit,
  };
}

/**
 * Assemble the Host runtime. `compose` is an optional adapter implementing
 * composition.preview/apply; tests may inject it, production hosts build it
 * from the scratch profile store once T3 is integrated.
 */
export async function createHostRuntime({config, dshHome, now = () => Date.now(), compose = undefined, compositionDigest: compositionDigestOverride = undefined} = {}) {
  const validated = validateWorkbenchConfigV1(config);
  const catalog = validated.catalog.modules;
  const access = createAccessRegistry({
    schema_version: 1,
    revision: 0,
    contexts: validated.contexts.map((context) => context.access),
    profile_refs: validated.profile_refs,
    displays: validated.contexts.map((context) => ({context_ref: context.access.context_ref, ...context.display})),
  });
  const registry = createRegistry({catalog, now});
  const actions = createActionService({registry, access, now});
  const compositionDigest = typeof compositionDigestOverride === 'string' && /^[a-f0-9]{64}$/.test(compositionDigestOverride)
    ? compositionDigestOverride
    : digestOf({
      schema_version: 1,
      fixture_mode: validated.fixture_mode,
      host_version: HOST_BASELINE.version,
      modules: catalog.map((manifest) => ({id: manifest.id, sha256: manifest.sha256})),
    });
  registry.setComposition({ordered: catalog.map((manifest) => manifest.id), composition_digest: compositionDigest});

  const descriptors = new Map();
  if (validated.fixture_mode) {
    for (const manifest of catalog) {
      const descriptor = createFixtureDescriptor({
        manifest,
        status: validated.fixture_status?.[manifest.id],
        compositionDigest,
        now,
      });
      registry.registerDescriptor(descriptor);
      descriptors.set(manifest.id, descriptor);
    }
  }

  const fixtures = validated.fixture_mode === true;
  const catalogSummaries = catalog.map((manifest) => ({
    module_id: manifest.id,
    name: manifest.name,
    release_version: manifest.release_version,
    entry_kind: manifest.entry.kind,
    fixture: validated.catalog.fixtures === true,
  }));
  const rpc = createRpcHandler({access, registry, actions, compose, fixtures, catalog: catalogSummaries, now});
  const handler = rpc.handler;
  let disposed = false;

  function runtimeHandle() {
    return {
      schema_version: CONFIG_SCHEMA_VERSION,
      fixture_mode: fixtures,
      catalog_ref: validated.catalog.catalog_ref,
      catalog: catalogSummaries.map((row) => ({...row})),
      host_version: HOST_BASELINE.version,
      blocked_reason: null,
      access,
      registry,
      actions,
      registerDescriptor(rawDescriptor) {
        if (disposed) throw new ContractError('INVALID_STATE', 'local-workbench', 'runtime is disposed');
        return registry.registerDescriptor(rawDescriptor);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        actions.dispose();
        registry.dispose();
        access.dispose();
      },
      get disposed() {
        return disposed;
      },
    };
  }

  return {
    handler,
    access,
    registry,
    actions,
    descriptors,
    catalog: catalogSummaries.map((row) => ({...row})),
    fixture_mode: fixtures,
    composition_digest: compositionDigest,
    validateConfig: validateWorkbenchConfigV1,
    emitFixtureStatus(moduleId, next) {
      const descriptor = descriptors.get(moduleId);
      if (descriptor === undefined) return false;
      descriptor.emit(next);
      return true;
    },
    createServiceHandle: runtimeHandle,
    dispose() {
      if (disposed) return;
      disposed = true;
      actions.dispose();
      registry.dispose();
      access.dispose();
    },
    get disposed() {
      return disposed;
    },
  };
}

/** Build an empty runtime for a Host with no workbench config yet. */
export function createBlockedRuntime({reason = 'CONFIG_MISSING'} = {}) {
  const blocked = {
    schema_version: CONFIG_SCHEMA_VERSION,
    blocked_reason: reason,
    fixture_mode: false,
    registerDescriptor() {
      throw new ContractError('INVALID_STATE', 'local-workbench', 'workbench config is missing');
    },
    dispose() {},
    get disposed() {
      return true;
    },
  };
  return {service: blocked, reason};
}

/**
 * Create the Cordis plugin object used by bundle/index.js. The `connection`
 * service must be present; registration is effect-scoped by the connection
 * service itself, and the runtime is disposed with the plugin fiber.
 */
export function createHostPlugin({env = process.env, loadRuntime = createHostRuntime, dynamicCompose} = {}) {
  return {
    name: 'local-workbench',
    inject: ['connection'],
    async apply(ctx) {
      const dshHome = resolveDshHome(ctx, env);
      const loaded = loadWorkbenchConfig({dshHome, env});
      let runtime;
      let service;
      if (!loaded.ok) {
        const blocked = createBlockedRuntime({reason: loaded.reason_code});
        service = blocked.service;
        runtime = undefined;
      } else {
        let compose = undefined;
        if (typeof dynamicCompose === 'function') compose = await dynamicCompose({config: loaded.config, dshHome});
        runtime = await loadRuntime({config: loaded.config, dshHome, compose, compositionDigest: compose?.composition_digest});
        service = runtime.createServiceHandle();
      }
      const registration = ctx.connection.rpc.handle('/local-workbench', async (endpoint, payload, signal, peer) => {
        if (runtime === undefined) {
          return {
            schema_version: 1,
            operation_id: typeof payload?.operation_id === 'string' ? payload.operation_id : 'invalid-request',
            view_epoch: Number.isSafeInteger(payload?.view_epoch) ? payload.view_epoch : 0,
            scope_generation: 1,
            status: 'unavailable',
            reason_code: service.blocked_reason === 'CONFIG_MISSING' ? 'PROFILE_NOT_FOUND' : service.blocked_reason,
          };
        }
        return runtime.handler(endpoint, payload, signal, peer);
      });
      ctx.provide('localWorkbench', {
        schema_version: service.schema_version,
        fixture_mode: service.fixture_mode,
        catalog_ref: service.catalog_ref,
        host_version: service.host_version,
        access: service.access,
        registry: service.registry,
        actions: service.actions,
        registerDescriptor(rawDescriptor) {
          return service.registerDescriptor(rawDescriptor);
        },
        blocked_reason: runtime === undefined ? service.blocked_reason : null,
        dispose() {
          service.dispose();
        },
        get disposed() {
          return service.disposed;
        },
      });
      ctx.effect(() => () => {
        if (typeof registration === 'function') registration();
        runtime?.dispose();
      }, 'local-workbench: rpc and runtime');
      ctx.logger?.info?.('local-workbench: workbench RPC channel registered');
    },
  };
}

/** Best-effort DSH_HOME from the Host service, then the environment. */
export function resolveDshHome(ctx, env = process.env) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined;
    if (typeof service === 'function') {
      const value = service();
      if (typeof value === 'string' && value !== '') return value;
    }
    if (typeof service === 'string' && service !== '') return service;
  } catch {
    // Fall through to the environment.
  }
  return typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : null;
}

// Re-exported fixed sets used by tests and the adapter layer.
export {MODULE_STATES, NETWORK_MODES, ACTIVE_OPERATION_STATES, isOwnerPeer};
