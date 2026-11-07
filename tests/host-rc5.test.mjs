// UI-04/05 adapter: strict local config, scratch-bound profile root, fixture
// descriptors and plugin wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync, writeFileSync} from 'node:fs';
import {
  CONFIG_RELATIVE_PATH,
  createBlockedRuntime,
  createFixtureDescriptor,
  createHostRuntime,
  loadWorkbenchConfig,
  resolveConfigPath,
  resolveDshHome,
  resolveProfileStoreRoot,
  validateWorkbenchConfigV1,
} from '../src/host-rc5.mjs';
import {
  createFakeCtx,
  createRecordingConnection,
  fixtureConfig,
  fixtureContext,
  fixtureManifest,
  invokeHttpRoute,
  makeTempRoot,
  ownerPeer,
  rpcRequest,
} from './helpers/host-fixtures.mjs';

test('strict config accepts the fixture config and rejects unsafe variants', () => {
  const config = fixtureConfig();
  assert.doesNotThrow(() => validateWorkbenchConfigV1(config));
  const withStore = fixtureConfig({profileStore: {root_ref: 'workbench/profiles', profile_id: 'fixture'}});
  assert.doesNotThrow(() => validateWorkbenchConfigV1(withStore));

  const cases = [
    ['unknown top field', {...fixtureConfig(), extra: true}],
    ['absolute store root', fixtureConfig({profileStore: {root_ref: 'C:/Users/admin/.dsh', profile_id: 'x'}})],
    ['traversal store root', fixtureConfig({profileStore: {root_ref: 'workbench/../../escape', profile_id: 'x'}})],
    ['store outside fixture mode', {...fixtureConfig({profileStore: {root_ref: 'workbench/profiles', profile_id: 'x'}}), fixture_mode: false}],
    ['module not in catalog', fixtureConfig({contexts: [{...fixtureContext({modules: ['05']}), access: {...fixtureContext({modules: ['05']}).access, allowed_module_ids: ['06']}}]})],
    ['duplicate context', fixtureConfig({contexts: [fixtureContext(), fixtureContext()]})],
    ['secret display field', (() => {
      const value = fixtureConfig();
      value.contexts[0].display.session_token = 'sk-live';
      return value;
    })()],
    ['bad fixture status', fixtureConfig({fixtureStatus: {'05': {state: 'exploded'}}})],
  ];
  for (const [label, value] of cases) assert.throws(() => validateWorkbenchConfigV1(value), undefined, label);
});

test('config resolution honours DSH_HOME and the explicit override', () => {
  const root = makeTempRoot('workbench-path-');
  try {
    const home = root.dir('home');
    assert.equal(resolveConfigPath({dshHome: home, env: {}}), join(home, ...CONFIG_RELATIVE_PATH.split('/')));
    assert.equal(resolveConfigPath({dshHome: null, env: {}}), null);
    const override = join(root.root, 'override.json');
    assert.equal(resolveConfigPath({dshHome: home, env: {DSH_WORKBENCH_CONFIG: override}}), override);
    assert.throws(() => resolveConfigPath({dshHome: home, env: {DSH_WORKBENCH_CONFIG: 'relative.json'}}));
  } finally {
    root.cleanup();
  }
});

test('loadWorkbenchConfig reports missing/unparseable/invalid config without throwing', () => {
  const root = makeTempRoot('workbench-load-');
  try {
    const home = root.dir('home');
    const missing = loadWorkbenchConfig({dshHome: home, env: {}});
    assert.equal(missing.ok, false);
    assert.equal(missing.reason_code, 'PROFILE_NOT_FOUND');
    mkdirSync(join(home, 'workbench'), {recursive: true});
    writeFileSync(join(home, 'workbench', 'workbench.json'), '{not json');
    const broken = loadWorkbenchConfig({dshHome: home, env: {}});
    assert.equal(broken.ok, false);
    assert.equal(broken.reason_code, 'INVALID_REQUEST');
    writeFileSync(join(home, 'workbench', 'workbench.json'), JSON.stringify({schema_version: 99}));
    const invalid = loadWorkbenchConfig({dshHome: home, env: {}});
    assert.equal(invalid.ok, false);
    writeFileSync(join(home, 'workbench', 'workbench.json'), JSON.stringify({...fixtureConfig(), credentials: ['sk']}));
    assert.equal(loadWorkbenchConfig({dshHome: home, env: {}}).reason_code, 'INVALID_REQUEST');
  } finally {
    root.cleanup();
  }
});

test('profile store roots stay strictly under DSH_HOME and require fixture mode', () => {
  const root = makeTempRoot('workbench-store-');
  try {
    const home = root.dir('home');
    const config = fixtureConfig({profileStore: {root_ref: 'workbench/profiles', profile_id: 'fixture'}});
    const resolved = resolveProfileStoreRoot({config, dshHome: home});
    assert.equal(resolved.root, join(home, 'workbench', 'profiles'));
    assert.equal(resolved.profile_id, 'fixture');
    const escaped = fixtureConfig({profileStore: {root_ref: 'other/place', profile_id: 'fixture'}});
    assert.throws(() => resolveProfileStoreRoot({config: escaped, dshHome: null}));
  } finally {
    root.cleanup();
  }
});

test('runtime with fixture status overrides maps panel keys and blocks missing owners', async () => {
  const config = fixtureConfig({
    fixtureStatus: {'05': {state: 'attention', reason_code: 'MODULE_BUSY'}},
  });
  const runtime = await createHostRuntime({config});
  const context = config.contexts[0];
  const statuses = await runtime.registry.snapshot(
    {
      scope_ref: context.access.scope_ref,
      scope_generation: context.access.scope_generation,
      session_ref: context.access.session_ref,
      caller_ref: context.access.context_ref,
      context_revision: context.display.context_revision,
    },
    {context_ref: context.access.context_ref},
  );
  const module05 = statuses.modules.find((module) => module.module_id === '05');
  assert.equal(module05.state, 'attention');
  assert.equal(module05.reason_code, 'MODULE_BUSY');
  const descriptor05 = runtime.descriptors.get('05');
  const intent = await descriptor05.planOpen({scope_ref: 'scope/one', scope_generation: 1, session_ref: null, caller_ref: 'ctx-one', context_revision: 'ctx-rev-1'});
  assert.equal(intent.target.panel_key, 'local-memory');
  const descriptor07 = runtime.descriptors.get('07');
  const intent07 = await descriptor07.planOpen({scope_ref: 'scope/one', scope_generation: 1, session_ref: null, caller_ref: 'ctx-one', context_revision: 'ctx-rev-1'});
  assert.equal(intent07.target.panel_key, 'local-context');
  runtime.dispose();
});

test('runtime without fixture mode has no descriptors and reports NOT_READY', async () => {
  const config = fixtureConfig({fixtureMode: false});
  const runtime = await createHostRuntime({config});
  const response = await runtime.handler('status.get', rpcRequest(config.contexts[0], {}), undefined, ownerPeer());
  assert.equal(response.status, 'ok');
  assert.ok(response.data.modules.every((module) => module.state === 'blocked' && module.reason_code === 'NOT_READY'));
  assert.equal(runtime.descriptors.size, 0);
  runtime.dispose();
});

test('fixture descriptors are deterministic and never claim a real release', async () => {
  const manifest = fixtureManifest('05');
  const descriptor = createFixtureDescriptor({manifest});
  const trusted = {scope_ref: 'scope/one', scope_generation: 1, session_ref: null, caller_ref: 'ctx-one', context_revision: 'ctx-rev-1'};
  const first = await descriptor.getStatus(trusted);
  const second = await descriptor.getStatus(trusted);
  assert.equal(first.module_id, '05');
  assert.equal(first.scope_ref, 'scope/one');
  assert.ok(first.capabilities.includes('fixture.capability'));
  assert.equal(second.state, first.state);
  const rejected = await descriptor.planOpen(trusted).then(() => '').catch(() => 'no');
  assert.equal(rejected, '');
  descriptor.dispose();
});

test('blocked runtime stays inert and cannot register descriptors', async () => {
  const blocked = createBlockedRuntime({reason: 'CONFIG_MISSING'});
  assert.equal(blocked.service.blocked_reason, 'CONFIG_MISSING');
  assert.throws(() => blocked.service.registerDescriptor({}));
  blocked.service.dispose();
  assert.equal(blocked.service.disposed, true);
});

test('resolveDshHome prefers the host service then DSH_HOME then null', () => {
  assert.equal(resolveDshHome({get: () => () => 'C:/fake/home'}, {}), 'C:/fake/home');
  assert.equal(resolveDshHome({get: () => undefined}, {DSH_HOME: 'E:/env/home'}), 'E:/env/home');
  assert.equal(resolveDshHome({get: () => undefined}, {}), null);
  assert.equal(resolveDshHome({get() {
    throw new Error('service unavailable');
  }}, {DSH_HOME: 'E:/env/home'}), 'E:/env/home');
});

test('plugin works through a fake Host service pair with an explicit config override', async () => {
  const {createHostPlugin} = await import('../src/host-rc5.mjs');
  const config = fixtureConfig();
  const temp = makeTempRoot('workbench-plugin-');
  temp.write('config/workbench.json', config);
  const host = createRecordingConnection();
  const ctx = createFakeCtx({connection: host.connection, webServer: host.webServer});
  const previous = process.env.DSH_WORKBENCH_CONFIG;
  process.env.DSH_WORKBENCH_CONFIG = join(temp.root, 'config', 'workbench.json');
  try {
    await createHostPlugin().apply(ctx);
    const route = host.routes.get('/local-workbench');
    assert.ok(route);
    const listed = await invokeHttpRoute(route, {endpoint: 'context.list', payload: rpcRequest(null, {})});
    assert.equal(listed.value.status, 'ok');
    const context = config.contexts[0];
    const status = await invokeHttpRoute(route, {endpoint: 'status.get', payload: rpcRequest(context, {})});
    assert.equal(status.value.status, 'ok');
    await ctx.disposeAll();
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKBENCH_CONFIG;
    else process.env.DSH_WORKBENCH_CONFIG = previous;
    temp.cleanup();
  }
});
