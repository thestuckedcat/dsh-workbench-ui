// UI-RPC-01: fixed business envelopes, owner/scope checks, sanitization, limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostRuntime, validateWorkbenchConfigV1} from '../src/host-rc5.mjs';
import {
  fixtureConfig,
  fixtureContext,
  fixtureManifest,
  nonOwnerPeer,
  ownerPeer,
  rpcRequest,
} from './helpers/host-fixtures.mjs';

async function runtimeWith({compose, ...overrides} = {}) {
  const config = fixtureConfig(overrides);
  const runtime = await createHostRuntime({config, compose, now: () => Date.parse('2026-11-07T00:00:00.000Z')});
  return {config, context: config.contexts[0], runtime};
}

function assertBusiness(response, {status}) {
  assert.equal(response.schema_version, 1);
  assert.equal(typeof response.operation_id, 'string');
  assert.equal(typeof response.view_epoch, 'number');
  assert.equal(typeof response.scope_generation, 'number');
  assert.equal(response.status, status);
  if (status === 'ok') {
    assert.ok('data' in response);
    assert.ok(!('reason_code' in response));
  } else {
    assert.ok(!('data' in response));
    assert.equal(typeof response.reason_code, 'string');
  }
}

test('context.list works with the reserved bootstrap ref for owner peers only', async () => {
  const {runtime} = await runtimeWith();
  const ok = await runtime.handler('context.list', rpcRequest(null, {}), undefined, ownerPeer());
  assertBusiness(ok, {status: 'ok'});
  assert.equal(ok.data.fixture_mode, true);
  assert.equal(ok.data.contexts.length, 1);
  assert.equal(ok.data.contexts[0].context_ref, 'ctx-one');
  assert.equal(ok.data.contexts[0].profile_revision, 1);
  assert.equal(ok.data.contexts[0].label, 'Fixture project');
  assert.ok(Array.isArray(ok.data.diagnostics));
  assert.equal(ok.data.modules.length, 2);
  assert.deepEqual(ok.data.modules.map((module) => module.module_id), ['05', '07']);
  assert.ok(ok.data.modules.every((module) => module.fixture === true && typeof module.release_version === 'string' && module.entry_kind === 'panel'));

  const denied = await runtime.handler('context.list', rpcRequest(null, {}), undefined, nonOwnerPeer());
  assertBusiness(denied, {status: 'denied'});
  assert.equal(denied.reason_code, 'OWNER_REQUIRED');

  const bootstrapOnStatus = await runtime.handler('status.get', rpcRequest(null, {}), undefined, ownerPeer());
  assertBusiness(bootstrapOnStatus, {status: 'denied'});
  assert.equal(bootstrapOnStatus.reason_code, 'CONTEXT_UNBOUND');
  runtime.dispose();
});

test('status.get returns trusted scope status and after_revision does not repeat bodies', async () => {
  const {runtime, context} = await runtimeWith();
  const first = await runtime.handler('status.get', rpcRequest(context, {}), undefined, ownerPeer());
  assertBusiness(first, {status: 'ok'});
  assert.equal(first.data.changed, true);
  assert.equal(first.data.scope_ref, 'scope/one');
  assert.equal(first.data.scope_generation, 1);
  assert.equal(first.data.context_revision, 'ctx-rev-1');
  assert.equal(first.data.modules.length, 2);
  assert.deepEqual(first.data.modules.map((module) => module.module_id), ['05', '07']);
  assert.ok(first.data.modules.every((module) => module.state === 'ready'));

  const second = await runtime.handler('status.get', rpcRequest(context, {after_revision: first.data.revision}), undefined, ownerPeer());
  assertBusiness(second, {status: 'ok'});
  assert.equal(second.data.changed, false);
  assert.deepEqual(second.data.modules, []);
  runtime.dispose();
});

test('fabricated, revoked and stale contexts are rejected before descriptors run', async () => {
  const {runtime, context} = await runtimeWith();
  const fabricated = await runtime.handler('status.get', rpcRequest(context, {}, {context_ref: 'ctx-other'}), undefined, ownerPeer());
  assertBusiness(fabricated, {status: 'denied'});
  assert.equal(fabricated.reason_code, 'CONTEXT_UNBOUND');

  const stale = await runtime.handler('status.get', rpcRequest(context, {}, {expected_scope_generation: 2}), undefined, ownerPeer());
  assertBusiness(stale, {status: 'denied'});
  assert.equal(stale.reason_code, 'STALE_SCOPE');

  runtime.access.revokeContext('ctx-one');
  const revoked = await runtime.handler('status.get', rpcRequest(context, {}), undefined, ownerPeer());
  assertBusiness(revoked, {status: 'denied'});
  assert.equal(revoked.reason_code, 'SCOPE_REVOKED');
  runtime.dispose();
});

test('navigation.prepare returns accepted intents and fixed-code rejections', async () => {
  const {runtime, context} = await runtimeWith();
  const accepted = await runtime.handler('navigation.prepare', rpcRequest(context, {module_id: '05'}), undefined, ownerPeer());
  assertBusiness(accepted, {status: 'ok'});
  assert.equal(accepted.data.status, 'accepted');
  assert.equal(accepted.data.navigation_intent.target.panel_key, 'local-memory');

  const deniedModule = await runtime.handler('navigation.prepare', rpcRequest(context, {module_id: '06'}), undefined, ownerPeer());
  assertBusiness(deniedModule, {status: 'ok'});
  assert.equal(deniedModule.data.status, 'denied');
  assert.equal(deniedModule.data.reason_code, 'MODULE_DENIED');
  runtime.dispose();
});

test('input validation, unknown endpoints and limits use fixed invalid envelopes', async () => {
  const {runtime, context} = await runtimeWith();
  const unknownEndpoint = await runtime.handler('system.exec', rpcRequest(context, {}), undefined, ownerPeer());
  assertBusiness(unknownEndpoint, {status: 'invalid'});
  assert.equal(unknownEndpoint.reason_code, 'UNKNOWN_ENDPOINT');

  const unknownField = await runtime.handler('status.get', rpcRequest(context, {command: 'whoami'}), undefined, ownerPeer());
  assertBusiness(unknownField, {status: 'invalid'});
  assert.equal(unknownField.reason_code, 'INVALID_REQUEST');

  const oversized = await runtime.handler('status.get', rpcRequest(context, {blob: 'x'.repeat(70 * 1024)}), undefined, ownerPeer());
  assertBusiness(oversized, {status: 'invalid'});
  assert.equal(oversized.reason_code, 'LIMIT_EXCEEDED');

  for (const payload of [null, 'string', 42, {schema_version: 1}, {operation_id: 'x', bad: true}]) {
    const response = await runtime.handler('status.get', payload, undefined, ownerPeer());
    assertBusiness(response, {status: 'invalid'});
  }
  runtime.dispose();
});

test('handler never throws and never leaks error text, paths or secrets', async () => {
  const {runtime, context} = await runtimeWith({fixtureMode: false});
  // Poison the registry with a status that throws a Secret-bearing error.
  runtime.registry.registerDescriptor({
    contract_version: 1,
    id: '05',
    release_version: '0.0.0-fixture.1',
    entry: {kind: 'panel', ref: 'local-memory'},
    async getStatus() {
      throw new Error('C:\\Users\\admin\\.dsh\\.credentials.yaml apiKey=sk-live-secret');
    },
    subscribe() {
      return () => {};
    },
    planOpen() {
      return Promise.reject(new Error('token=abcdef'));
    },
    quiesce() {
      return Promise.resolve({status: 'idle'});
    },
    dispose() {},
  });
  const response = await runtime.handler('status.get', rpcRequest(context, {}), undefined, ownerPeer());
  assertBusiness(response, {status: 'ok'});
  const serialized = JSON.stringify(response);
  for (const forbidden of ['credentials', 'apiKey', 'sk-live-secret', 'C:\\\\', 'token=']) assert.ok(!serialized.includes(forbidden), forbidden);

  const rejected = await runtime.handler('navigation.prepare', rpcRequest(context, {module_id: '05'}), undefined, ownerPeer());
  assertBusiness(rejected, {status: 'ok'});
  assert.equal(rejected.data.status, 'unavailable');
  assert.ok(!JSON.stringify(rejected).includes('abcdef'));
  runtime.dispose();
});

test('receipts and operation.get are diagnostic and context-scoped', async () => {
  const {runtime, context} = await runtimeWith();
  const prepared = await runtime.handler('navigation.prepare', rpcRequest(context, {module_id: '05'}), undefined, ownerPeer());
  const intentId = prepared.data.navigation_intent.intent_id;
  const receipt = await runtime.handler('navigation.receipt', rpcRequest(context, {intent_id: intentId, client_state: 'opened'}), undefined, ownerPeer());
  assertBusiness(receipt, {status: 'ok'});
  assert.equal(receipt.data.recorded, true);
  const unknownReceipt = await runtime.handler('navigation.receipt', rpcRequest(context, {intent_id: 'nope', client_state: 'opened'}), undefined, ownerPeer());
  assert.equal(unknownReceipt.data.recorded, false);
  const operation = await runtime.handler('operation.get', rpcRequest(context, {operation_ref: prepared.data.operation_id}), undefined, ownerPeer());
  assertBusiness(operation, {status: 'ok'});
  assert.equal(operation.data.state, 'opened');
  runtime.dispose();
});

test('composition.preview/apply go through the injected adapter and profile allow-list', async () => {
  const calls = [];
  const compose = {
    async preview({trusted, input}) {
      calls.push({kind: 'preview', trusted, input});
      return {preview_id: 'preview-1', diff: {added: ['07'], removed: [], changed: [], unchanged: ['05']}, composition_digest: 'f'.repeat(64), expires_at: '2026-11-07T00:10:00.000Z'};
    },
    async apply({input, operation_id: operationId}) {
      calls.push({kind: 'apply', input, operationId});
      return {status: 'restart_required', revision: 2, previous_revision: 1, composition_digest: 'f'.repeat(64), diagnostics: []};
    },
  };
  const {runtime, context} = await runtimeWith({compose});
  const preview = await runtime.handler('composition.preview', rpcRequest(context, {profile_ref: 'profiles/fixture', expected_revision: 1, selected_ids: ['05', '07']}), undefined, ownerPeer());
  assertBusiness(preview, {status: 'ok'});
  assert.equal(preview.data.preview_id, 'preview-1');
  assert.equal(calls[0].kind, 'preview');

  const denied = await runtime.handler('composition.preview', rpcRequest(context, {profile_ref: 'profiles/other', expected_revision: 1, selected_ids: ['05']}), undefined, ownerPeer());
  assertBusiness(denied, {status: 'denied'});
  assert.equal(denied.reason_code, 'PROFILE_DENIED');

  const apply = await runtime.handler('composition.apply', rpcRequest(context, {preview_id: 'preview-1', expected_revision: 1}), undefined, ownerPeer());
  assertBusiness(apply, {status: 'ok'});
  assert.equal(apply.data.status, 'restart_required');
  runtime.dispose();
});

test('composition endpoints are unavailable when the adapter is absent', async () => {
  const {runtime, context} = await runtimeWith();
  const preview = await runtime.handler('composition.preview', rpcRequest(context, {profile_ref: 'profiles/fixture', expected_revision: 1, selected_ids: ['05']}), undefined, ownerPeer());
  assertBusiness(preview, {status: 'unavailable'});
  assert.equal(preview.reason_code, 'PROFILE_NOT_FOUND');
  runtime.dispose();
});

test('fixture status overrides are visible through status.get', async () => {
  const config = fixtureConfig({
    contexts: [fixtureContext({modules: ['05', '07']})],
    fixtureStatus: {
      '05': {state: 'busy', active_operations: [{operation_id: 'fixture-op', kind: 'write', state: 'outcome_unknown'}]},
      '07': {state: 'attention', reason_code: 'QUIESCE_BUSY'},
    },
  });
  const runtime = await createHostRuntime({config});
  const context = config.contexts[0];
  const response = await runtime.handler('status.get', rpcRequest(context, {}), undefined, ownerPeer());
  assert.equal(response.status, 'ok');
  const module05 = response.data.modules.find((module) => module.module_id === '05');
  assert.equal(module05.state, 'busy');
  assert.equal(module05.active_operations[0].state, 'outcome_unknown');
  const module07 = response.data.modules.find((module) => module.module_id === '07');
  assert.equal(module07.state, 'attention');
  runtime.dispose();
});

test('the catalog with a network module is rejected at config load (no hidden egress)', async () => {
  const networkModule = fixtureManifest('05', {network: {mode: 'approved_model', target_refs: ['trusted/model']}});
  const config = fixtureConfig({modules: [networkModule]});
  assert.throws(() => validateWorkbenchConfigV1(config));
  await assert.rejects(() => createHostRuntime({config}));
});
