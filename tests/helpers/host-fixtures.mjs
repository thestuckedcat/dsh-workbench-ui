// Shared test fixtures for the Host half: manifests, local config, trusted
// contexts, a recording connection service and a minimal Cordis-like ctx.
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HOST_BASELINE} from '../../src/contracts.mjs';

export const FIXTURE_SHA = Object.freeze({'05': 'b'.repeat(64), '07': 'c'.repeat(64)});

export function fixtureManifest(id, overrides = {}) {
  const base = {
    schema_version: 1,
    id,
    name: id === '05' ? 'Fixture memory module' : 'Fixture context module',
    release_version: '0.0.0-fixture.1',
    artifact_ref: `fixtures/${id}`,
    sha256: FIXTURE_SHA[id],
    host: {
      verified_versions: [HOST_BASELINE.version],
      declared_range: '>=0.2.0-rc.2 <0.2.2',
      services: [],
    },
    requires: [],
    provides: {
      tools: [{name: `fixture_${id}_read`, operation_kind: 'read'}],
      slots: [{name: 'main', key: id === '05' ? 'local-memory' : 'local-context', mode: 'keyed'}],
      writers: id === '05' ? [{resource: 'memory.store', scope: 'scope'}] : [],
      hooks: id === '07' ? [{name: 'context/observe', mode: 'observe'}] : [],
    },
    network: {mode: 'none', target_refs: []},
    dispose: {supports_quiesce: true, timeout_ms: 5000},
    entry: {kind: 'panel', ref: id === '05' ? 'local-memory' : 'local-context'},
    evidence: {
      release_ref: `fixture/${id}/release`,
      contract_tests_ref: `fixture/${id}/contract-tests`,
      host_smoke_ref: `fixture/${id}/host-smoke`,
      network_ref: `fixture/${id}/network`,
    },
  };
  return {...base, ...overrides};
}

export function fixtureContext({context_ref: contextRef = 'ctx-one', scopeRef = 'scope/one', generation = 1, modules = ['05', '07'], profileRef = 'profiles/fixture'} = {}) {
  return {
    access: {
      context_ref: contextRef,
      scope_ref: scopeRef,
      scope_generation: generation,
      session_ref: 'session/one',
      allowed_module_ids: modules.slice(),
      active: true,
    },
    display: {
      label: 'Fixture project',
      context_revision: `ctx-rev-${generation}`,
      profile_ref: profileRef,
      profile_revision: 1,
      selected_module_ids: modules.slice(),
    },
  };
}

export function fixtureConfig({contexts, modules, fixtureStatus, profileStore, fixtureMode} = {}) {
  const catalogModules = modules ?? [fixtureManifest('05'), fixtureManifest('07')];
  const config = {
    schema_version: 1,
    fixture_mode: fixtureMode ?? true,
    profile_refs: ['profiles/fixture'],
    catalog: {
      catalog_ref: 'profile/components.json',
      fixtures: true,
      modules: catalogModules,
    },
    contexts: contexts ?? [fixtureContext({modules: catalogModules.map((manifest) => manifest.id)})],
  };
  if (fixtureStatus !== undefined) config.fixture_status = fixtureStatus;
  if (profileStore !== undefined) config.profile_store = profileStore;
  return config;
}

export function ownerPeer() {
  return {id: 'peer-owner', principal: {kind: 'owner'}, ctx: {}, signal: new AbortController().signal};
}

export function nonOwnerPeer() {
  return {id: 'peer-remote', principal: {kind: 'remote'}, ctx: {}, signal: new AbortController().signal};
}

export function trustedFor(context, overrides = {}) {
  return {
    scope_ref: context.access.scope_ref,
    scope_generation: context.access.scope_generation,
    session_ref: context.access.session_ref,
    caller_ref: context.access.context_ref,
    context_revision: context.display.context_revision,
    ...overrides,
  };
}

let operationCounter = 0;

export function rpcRequest(context, input = {}, overrides = {}) {
  operationCounter += 1;
  return {
    schema_version: 1,
    operation_id: `test-op-${operationCounter}`,
    context_ref: context?.access?.context_ref ?? 'bootstrap',
    expected_scope_generation: context?.access?.scope_generation ?? 1,
    view_epoch: 3,
    input,
    ...overrides,
  };
}

/**
 * Minimal Host services double for the workbench HTTP carrier:
 * `connection.admit` (fixed owner peer) + `webServer.register` (captured routes).
 */
export function createRecordingConnection({peer = ownerPeer(), channel = '/local-workbench'} = {}) {
  const routes = new Map();
  const connection = {
    admit(req) {
      return {peer: req?.testPeer ?? peer};
    },
  };
  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate webServer route ${route.path}`);
      routes.set(route.path, route);
      return () => {
        routes.delete(route.path);
      };
    },
  };
  const service = {
    connection,
    webServer,
    routes,
    get(routePath = channel) {
      return routes.get(routePath);
    },
    async call(endpoint, payload, signal, peerOverride) {
      const route = routes.get(channel);
      if (route === undefined) throw new Error(`no route registered for ${channel}`);
      if (peerOverride !== undefined) {
        connection.admit = () => ({peer: peerOverride});
      }
      const response = await invokeHttpRoute(route, {channel, endpoint, payload, signal});
      return response;
    },
  };
  return service;
}

/** Build a fake node:http request accepted by the workbench carrier. */
export function createFakeHttpRequest({channel = '/local-workbench', endpoint = 'status.get', payload = {}, rpcId = 'test-rpc-1', peer} = {}) {
  const body = JSON.stringify({type: 'client-request', rpcId, method: endpoint, payload});
  return {
    method: 'POST',
    url: `${channel}/${endpoint}`,
    headers: {'content-type': 'application/json'},
    testPeer: peer,
    on() {
      return this;
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, 'utf8');
    },
  };
}

/** Build a fake node:http response that captures status/body. */
export function createFakeHttpResponse() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    finished: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
      return this;
    },
    end(chunk = '') {
      this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      this.finished = true;
      return this;
    },
  };
}

/**
 * Invoke a captured webServer route like the real Host would, returning the
 * RpcResult `{ok,value}|{ok,error}` that the browser client would receive.
 */
export async function invokeHttpRoute(route, {channel = '/local-workbench', endpoint, payload, rpcId = 'test-rpc-1', peer} = {}) {
  const req = createFakeHttpRequest({channel, endpoint, payload, rpcId, peer});
  const res = createFakeHttpResponse();
  await route.handler(req, res, peer);
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error(`route did not return JSON (status ${res.statusCode}): ${res.body.slice(0, 200)}`);
  }
  if (parsed.type !== 'server-response' || parsed.rpcId !== rpcId) {
    throw new Error(`invalid server-response envelope: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return parsed.result;
}

/** Minimal Cordis-like context for the host plugin (plain-Node component tests). */
export function createFakeCtx({dshHome, connection, webServer, logger = console} = {}) {
  const services = new Map();
  const effects = [];
  const provided = new Map();
  const ctx = {
    logger,
    get(name) {
      if (name === 'dshHomePath' && typeof dshHome === 'string') return () => dshHome;
      return services.get(name);
    },
    provide(name, value) {
      provided.set(name, value);
      services.set(name, value);
      return () => {
        provided.delete(name);
        services.delete(name);
      };
    },
    effect(callback, _label) {
      const disposer = callback();
      effects.push(disposer);
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    get effectCount() {
      return effects.length;
    },
    provided,
    services,
    async disposeAll() {
      for (const disposer of effects.reverse()) if (typeof disposer === 'function') disposer();
      effects.length = 0;
      provided.clear();
      services.clear();
    },
  };
  if (connection !== undefined) services.set('connection', connection);
  if (webServer !== undefined) services.set('webServer', webServer);
  // Cordis exposes provided services as context properties; mirror that for
  // `ctx.connection` / `ctx.webServer` in the host plugin.
  for (const name of ['connection', 'webServer', 'localWorkbench']) {
    Object.defineProperty(ctx, name, {
      configurable: true,
      get() {
        return services.get(name);
      },
    });
  }
  return ctx;
}

/** Temporary workspace root (never under the user's real DSH_HOME). */
export function makeTempRoot(prefix = 'workbench-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    dir(...parts) {
      const path = join(root, ...parts);
      mkdirSync(path, {recursive: true});
      return path;
    },
    write(relative, content) {
      const path = join(root, ...relative.split('/'));
      mkdirSync(join(path, '..'), {recursive: true});
      writeFileSync(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
      return path;
    },
    cleanup() {
      rmSync(root, {recursive: true, force: true});
    },
  };
}

/** Write a workbench config into a scratch DSH_HOME layout and return paths. */
export function writeScratchHome({config, runtimeDir} = {}) {
  const temp = makeTempRoot('workbench-home-');
  const home = temp.dir('home');
  const configPath = join(home, 'workbench', 'workbench.json');
  mkdirSync(join(home, 'workbench'), {recursive: true});
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {home, configPath, temp, ...(runtimeDir === undefined ? {} : {runtimeDir})};
}

/** Build a custom descriptor for registry/action tests. */
export function customDescriptor(manifest, {status, onPlanOpen, onStatus, compositionDigest = 'd'.repeat(64)} = {}) {
  const listeners = new Map();
  let revision = 1;
  const baseStatus = status ?? {state: 'ready', reason_code: null, capabilities: [`fixture.${manifest.id}`], active_operations: []};
  let current = baseStatus;
  function buildStatus(trusted) {
    return {
      schema_version: 1,
      module_id: manifest.id,
      scope_ref: trusted.scope_ref,
      session_ref: trusted.session_ref,
      generation: trusted.scope_generation,
      revision,
      state: current.state,
      reason_code: current.reason_code,
      active_operations: current.active_operations,
      updated_at: '2026-11-07T00:00:00.000Z',
      capabilities: current.capabilities,
    };
  }
  return {
    contract_version: 1,
    id: manifest.id,
    release_version: manifest.release_version,
    entry: {kind: manifest.entry.kind, ref: manifest.entry.ref},
    getStatus(trusted) {
      if (typeof onStatus === 'function') {
        const override = onStatus(trusted);
        if (override !== undefined) return Promise.resolve(override);
      }
      return Promise.resolve(buildStatus(trusted));
    },
    subscribe(trusted, listener) {
      listeners.set(listener, trusted);
      return () => listeners.delete(listener);
    },
    planOpen(trusted, _signal) {
      if (typeof onPlanOpen === 'function') return onPlanOpen(trusted);
      return Promise.resolve({
        schema_version: 1,
        intent_id: `intent-${manifest.id}-${revision}`,
        operation_id: `plan-${manifest.id}`,
        owner_module: manifest.id,
        scope_ref: trusted.scope_ref,
        scope_generation: trusted.scope_generation,
        context_revision: trusted.context_revision,
        module_revision: revision,
        composition_digest: compositionDigest,
        expires_at: new Date(Date.now() + 30000).toISOString(),
        target: {kind: 'panel', panel_key: manifest.id === '05' ? 'local-memory' : 'local-context'},
      });
    },
    quiesce() {
      return Promise.resolve({status: 'idle'});
    },
    dispose() {
      listeners.clear();
    },
    emit(next) {
      current = {...current, ...next};
      revision += 1;
      for (const [listener, trusted] of listeners) listener(buildStatus(trusted));
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}
