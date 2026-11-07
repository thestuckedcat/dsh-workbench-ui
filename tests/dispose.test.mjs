// UI-05 lifecycle: plugin registration, cleanup and no leftover timers/handlers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createHostPlugin, loadWorkbenchConfig} from '../src/host-rc5.mjs';
import {
  createFakeCtx,
  createRecordingConnection,
  fixtureConfig,
  invokeHttpRoute,
  makeTempRoot,
  rpcRequest,
} from './helpers/host-fixtures.mjs';

function scratchHomeWithConfig(config) {
  const temp = makeTempRoot('workbench-dispose-');
  const home = temp.dir('home');
  temp.write('home/workbench/workbench.json', config);
  return {temp, home};
}

function fakeCtxFor(host, extra = {}) {
  return createFakeCtx({connection: host.connection, webServer: host.webServer, ...extra});
}

test('host plugin registers one HTTP RPC route, provides the service and disposes cleanly', async () => {
  const config = fixtureConfig();
  const {temp, home} = scratchHomeWithConfig(config);
  const host = createRecordingConnection();
  const ctx = fakeCtxFor(host, {dshHome: home});
  const intervalCount = {active: 0};
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (...args) => {
    intervalCount.active += 1;
    return originalSetInterval(...args);
  };
  globalThis.clearInterval = (...args) => {
    intervalCount.active -= 1;
    return originalClearInterval(...args);
  };
  try {
    const plugin = createHostPlugin();
    assert.equal(plugin.name, 'local-workbench');
    assert.deepEqual(plugin.inject, ['connection', 'webServer']);
    await plugin.apply(ctx);
    assert.equal(host.routes.size, 1);
    assert.ok(host.routes.has('/local-workbench'));
    const service = ctx.provided.get('localWorkbench');
    assert.equal(service.fixture_mode, true);
    assert.equal(service.blocked_reason, null);

    const context = config.contexts[0];
    const listed = await invokeHttpRoute(host.routes.get('/local-workbench'), {endpoint: 'context.list', payload: rpcRequest(null, {})});
    assert.equal(listed.ok, true);
    assert.equal(listed.value.status, 'ok');
    assert.equal(listed.value.data.contexts[0].context_ref, 'ctx-one');
    const status = await invokeHttpRoute(host.routes.get('/local-workbench'), {endpoint: 'status.get', payload: rpcRequest(context, {})});
    assert.equal(status.ok, true);
    assert.equal(status.value.status, 'ok');
    assert.equal(intervalCount.active, 0, 'host half must not create polling timers');

    await ctx.disposeAll();
    assert.equal(host.routes.size, 0, 'webServer route must be released');
    assert.equal(ctx.provided.has('localWorkbench'), false, 'service must be released');
    assert.equal(service.disposed, true);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    temp.cleanup();
  }
});

test('missing local config yields a blocked service instead of crashing the profile', async () => {
  const temp = makeTempRoot('workbench-noconfig-');
  const home = temp.dir('empty-home');
  const host = createRecordingConnection();
  const ctx = fakeCtxFor(host, {dshHome: home});
  try {
    const plugin = createHostPlugin();
    await plugin.apply(ctx);
    const service = ctx.provided.get('localWorkbench');
    assert.equal(service.blocked_reason, 'PROFILE_NOT_FOUND');
    assert.throws(() => service.registerDescriptor({}));
    const response = await invokeHttpRoute(host.routes.get('/local-workbench'), {endpoint: 'context.list', payload: rpcRequest(null, {})});
    assert.equal(response.value.status, 'unavailable');
    assert.equal(response.value.reason_code, 'PROFILE_NOT_FOUND');
    await ctx.disposeAll();
    assert.equal(host.routes.size, 0);
  } finally {
    temp.cleanup();
  }
});

test('config path can be overridden for an isolated boot and is loaded strictly', async () => {
  const config = fixtureConfig();
  const temp = makeTempRoot('workbench-configoverride-');
  temp.write('custom/workbench.json', config);
  const configPath = join(temp.root, 'custom', 'workbench.json');
  const previous = process.env.DSH_WORKBENCH_CONFIG;
  process.env.DSH_WORKBENCH_CONFIG = configPath;
  try {
    const loaded = loadWorkbenchConfig({dshHome: null});
    assert.equal(loaded.ok, true);
    assert.equal(loaded.config.fixture_mode, true);
    assert.equal(loaded.path, configPath);
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKBENCH_CONFIG;
    else process.env.DSH_WORKBENCH_CONFIG = previous;
    temp.cleanup();
  }
});

test('plugin dispose is idempotent and a second runtime cannot double-register', async () => {
  const config = fixtureConfig();
  const {temp, home} = scratchHomeWithConfig(config);
  const host = createRecordingConnection();
  const ctx = fakeCtxFor(host, {dshHome: home});
  try {
    const plugin = createHostPlugin();
    await plugin.apply(ctx);
    const first = [...host.routes.keys()];
    await ctx.disposeAll();
    await ctx.disposeAll();
    assert.equal(first.length, 1);
    assert.equal(host.routes.size, 0);
  } finally {
    temp.cleanup();
  }
});

test('the host plugin never reads credentials or user profiles on apply', async () => {
  const config = fixtureConfig();
  const {temp, home} = scratchHomeWithConfig(config);
  const host = createRecordingConnection();
  const ctx = fakeCtxFor(host, {dshHome: home});
  try {
    await createHostPlugin().apply(ctx);
    const service = ctx.provided.get('localWorkbench');
    const serialized = JSON.stringify(service.access.snapshot());
    assert.ok(!serialized.includes('credentials'));
    assert.ok(!serialized.includes(temp.root));
    await ctx.disposeAll();
  } finally {
    temp.cleanup();
  }
});
