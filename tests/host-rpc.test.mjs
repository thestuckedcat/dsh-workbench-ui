// T4 real-rc.5 Host runtime test (runs under the installed Electron's embedded
// Node 24 via tools/test-rc5-host.mjs; skipped under the plain Node 26 runner).
//
// This is the "real Cordis, real lifecycle" layer: the workbench host plugin is
// mounted into a real pinned rc.5 Context with a local webServer/connection
// double, exercised end to end over its HTTP RPC carrier, then disposed. It
// does not boot a profile or render the client half; that stays a separately
// recorded limitation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  createRecordingConnection,
  fixtureConfig,
  invokeHttpRoute,
  nonOwnerPeer,
  ownerPeer,
  rpcRequest,
} from './helpers/host-fixtures.mjs';

const HOST_ROOT = process.env.DSH_AUDIT_APP_ROOT;
const RUN = typeof HOST_ROOT === 'string' && HOST_ROOT.endsWith('/dsh') && process.versions.electron !== undefined;
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CORDIS = `${HOST_ROOT}/node_modules/@deepseek-ai/cordis/lib/index.js`;
const BUNDLE = pathToFileURL(join(ROOT, 'bundle', 'index.js')).href;

function scratchConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-h24-'));
  mkdirSync(join(dir, 'workbench'), {recursive: true});
  const path = join(dir, 'workbench', 'workbench.json');
  writeFileSync(path, `${JSON.stringify(fixtureConfig(), null, 2)}\n`);
  return {dir, path, cleanup: () => rmSync(dir, {recursive: true, force: true})};
}

async function provideHostServices(ctx) {
  const host = createRecordingConnection();
  await ctx.plugin({
    name: 'audit-host-services-double',
    apply(inner) {
      inner.provide('connection', host.connection);
      inner.provide('webServer', host.webServer);
    },
  });
  return host;
}

test('real pinned rc.5 Cordis mounts, serves and disposes the workbench host plugin', {skip: !RUN}, async (t) => {
  assert.equal(process.versions.node, '24.21.0');
  assert.equal(process.versions.electron, '44.7.0');
  const {Context} = await import(pathToFileURL(CORDIS).href);
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
  });
  const host = await provideHostServices(ctx);

  const scratch = scratchConfig();
  t.after(() => scratch.cleanup());
  process.env.DSH_WORKBENCH_CONFIG = scratch.path;
  try {
    const bundle = await import(BUNDLE);
    assert.equal(bundle.name, 'local-workbench');
    assert.deepEqual(bundle.inject, ['connection', 'webServer']);
    const fiber = ctx.plugin(bundle);
    await fiber;
    assert.equal(host.routes.size, 1);
    const route = host.routes.get('/local-workbench');
    assert.ok(route);
    const service = ctx.get('localWorkbench');
    assert.ok(service);
    assert.equal(service.fixture_mode, true);

    const config = fixtureConfig();
    const context = config.contexts[0];
    const listed = await invokeHttpRoute(route, {endpoint: 'context.list', payload: rpcRequest(null, {})});
    assert.equal(listed.ok, true);
    assert.equal(listed.value.status, 'ok');
    assert.equal(listed.value.data.contexts.length, 1);
    const status = await invokeHttpRoute(route, {endpoint: 'status.get', payload: rpcRequest(context, {})});
    assert.equal(status.ok, true);
    assert.equal(status.value.status, 'ok');
    assert.equal(status.value.data.modules.length, 2);
    assert.ok(status.value.data.modules.every((module) => module.state === 'ready'));
    const denied = await invokeHttpRoute(route, {endpoint: 'context.list', payload: rpcRequest(null, {}), peer: nonOwnerPeer()});
    assert.equal(denied.value.status, 'denied');
    assert.equal(denied.value.reason_code, 'OWNER_REQUIRED');
    const badEnvelope = await invokeHttpRoute(route, {endpoint: 'status.get', payload: rpcRequest(null, {}), peer: ownerPeer()});
    assert.equal(badEnvelope.ok, true, 'owner bootstrap status is a business denial, not a transport failure');
    assert.equal(badEnvelope.value.status, 'denied');
    assert.equal(badEnvelope.value.reason_code, 'CONTEXT_UNBOUND');

    await fiber.dispose();
    assert.equal(host.routes.size, 0, 'webServer route must be released by the real fiber');
    assert.equal(service.disposed, true, 'runtime must be disposed with the plugin fiber');
  } finally {
    delete process.env.DSH_WORKBENCH_CONFIG;
  }
});

test('real pinned rc.5 Context keeps a blocked workbench when config is missing', {skip: !RUN}, async (t) => {
  const {Context} = await import(pathToFileURL(CORDIS).href);
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
  });
  const host = await provideHostServices(ctx);
  const previous = process.env.DSH_WORKBENCH_CONFIG;
  process.env.DSH_WORKBENCH_CONFIG = join(tmpdir(), 'workbench-missing-config.json');
  try {
    const bundle = await import(BUNDLE);
    await ctx.plugin(bundle);
    const service = ctx.get('localWorkbench');
    assert.equal(service.blocked_reason, 'PROFILE_NOT_FOUND');
    const route = host.routes.get('/local-workbench');
    const response = await invokeHttpRoute(route, {endpoint: 'context.list', payload: rpcRequest(null, {})});
    assert.equal(response.value.status, 'unavailable');
    assert.equal(response.value.reason_code, 'PROFILE_NOT_FOUND');
    await ctx.fiber.dispose();
    assert.equal(host.routes.size, 0);
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKBENCH_CONFIG;
    else process.env.DSH_WORKBENCH_CONFIG = previous;
  }
});
