// T4 real-rc.5 Host runtime test (runs under the installed Electron's embedded
// Node 24 via tools/test-rc5-host.mjs; skipped under the plain Node 26 runner).
//
// This is the "real Cordis, real lifecycle" layer: the workbench host plugin is
// mounted into a real pinned rc.5 Context with a local connection-service
// double, exercised end to end, then disposed. It does not boot a profile or
// render the client half; that stays a separately recorded limitation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixtureConfig, ownerPeer, nonOwnerPeer, rpcRequest} from './helpers/host-fixtures.mjs';

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

test('real pinned rc.5 Cordis mounts, serves and disposes the workbench host plugin', {skip: !RUN}, async (t) => {
  assert.equal(process.versions.node, '24.21.0');
  assert.equal(process.versions.electron, '44.7.0');
  const {Context} = await import(pathToFileURL(CORDIS).href);
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
  });
  const handlers = new Map();
  const connection = {
    rpc: {
      handle(channel, handler) {
        assert.equal(typeof channel, 'string');
        assert.equal(typeof handler, 'function');
        handlers.set(channel, handler);
        const dispose = ctx.effect(() => () => {
          handlers.delete(channel);
        }, 'audit: connection channel');
        return () => {
          dispose();
          handlers.delete(channel);
        };
      },
    },
  };
  await ctx.plugin({
    name: 'audit-connection-double',
    apply(inner) {
      inner.provide('connection', connection);
    },
  });

  const scratch = scratchConfig();
  t.after(() => scratch.cleanup());
  process.env.DSH_WORKBENCH_CONFIG = scratch.path;
  try {
    const bundle = await import(BUNDLE);
    assert.equal(bundle.name, 'local-workbench');
    assert.deepEqual(bundle.inject, ['connection']);
    const fiber = ctx.plugin(bundle);
    await fiber;
    assert.equal(handlers.size, 1);
    const handler = handlers.get('/local-workbench');
    const service = ctx.get('localWorkbench');
    assert.ok(service);
    assert.equal(service.fixture_mode, true);

    const config = fixtureConfig();
    const context = config.contexts[0];
    const listed = await handler('context.list', rpcRequest(null, {}), undefined, ownerPeer());
    assert.equal(listed.status, 'ok');
    assert.equal(listed.data.contexts.length, 1);
    const status = await handler('status.get', rpcRequest(context, {}), undefined, ownerPeer());
    assert.equal(status.status, 'ok');
    assert.equal(status.data.modules.length, 2);
    assert.ok(status.data.modules.every((module) => module.state === 'ready'));
    const denied = await handler('context.list', rpcRequest(null, {}), undefined, nonOwnerPeer());
    assert.equal(denied.status, 'denied');
    assert.equal(denied.reason_code, 'OWNER_REQUIRED');

    await fiber.dispose();
    assert.equal(handlers.size, 0, 'channel registration must be released by the real fiber');
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
  const handlers = new Map();
  await ctx.plugin({
    name: 'audit-connection-double',
    apply(inner) {
      inner.provide('connection', {
        rpc: {
          handle(channel, handler) {
            handlers.set(channel, handler);
            return () => handlers.delete(channel);
          },
        },
      });
    },
  });
  const previous = process.env.DSH_WORKBENCH_CONFIG;
  process.env.DSH_WORKBENCH_CONFIG = join(tmpdir(), 'workbench-missing-config.json');
  try {
    const bundle = await import(BUNDLE);
    await ctx.plugin(bundle);
    const service = ctx.get('localWorkbench');
    assert.equal(service.blocked_reason, 'PROFILE_NOT_FOUND');
    const response = await handlers.get('/local-workbench')('context.list', rpcRequest(null, {}), undefined, ownerPeer());
    assert.equal(response.status, 'unavailable');
    assert.equal(response.reason_code, 'PROFILE_NOT_FOUND');
    await ctx.fiber.dispose();
    assert.equal(handlers.size, 0);
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKBENCH_CONFIG;
    else process.env.DSH_WORKBENCH_CONFIG = previous;
  }
});
