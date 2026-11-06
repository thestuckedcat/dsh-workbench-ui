// UI-04/05: navigation prepare validation, receipts (diagnostic only), operations.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessRegistry} from '../src/access.mjs';
import {createRegistry} from '../src/registry.mjs';
import {createActionService} from '../src/actions.mjs';
import {
  customDescriptor,
  fixtureConfig,
  fixtureContext,
  fixtureManifest,
  trustedFor,
} from './helpers/host-fixtures.mjs';

const COMPOSITION = 'e'.repeat(64);

function harness({descriptors = [], moduleIds = ['05']} = {}) {
  const config = fixtureConfig({contexts: [fixtureContext({modules: moduleIds})]});
  const context = config.contexts[0];
  const access = createAccessRegistry({
    schema_version: 1,
    revision: 0,
    contexts: config.contexts.map((row) => row.access),
    profile_refs: config.profile_refs,
    displays: config.contexts.map((row) => ({context_ref: row.access.context_ref, ...row.display})),
  });
  const registry = createRegistry({catalog: config.catalog.modules});
  registry.setComposition({ordered: config.catalog.modules.map((manifest) => manifest.id), composition_digest: COMPOSITION});
  for (const descriptor of descriptors) registry.registerDescriptor(descriptor);
  const actions = createActionService({registry, access, now: () => Date.parse('2026-11-07T00:00:00.000Z')});
  return {config, context, trusted: trustedFor(context), access, registry, actions};
}

function descriptor05(overrides) {
  return customDescriptor(fixtureManifest('05'), {
    compositionDigest: COMPOSITION,
    onPlanOpen: (trusted) => Promise.resolve({
      schema_version: 1,
      intent_id: 'intent-1',
      operation_id: 'plan-1',
      owner_module: '05',
      scope_ref: trusted.scope_ref,
      scope_generation: trusted.scope_generation,
      context_revision: trusted.context_revision,
      module_revision: 1,
      composition_digest: COMPOSITION,
      expires_at: '2026-11-07T00:00:20.000Z',
      target: {kind: 'panel', panel_key: 'local-memory'},
    }),
    ...overrides,
  });
}

test('prepareNavigation accepts a matching panel intent and never claims it was opened', async () => {
  const {trusted, actions} = harness({descriptors: [descriptor05()]});
  const result = await actions.prepareNavigation({trusted, module_id: '05', operation_id: 'op-1'});
  assert.equal(result.status, 'accepted');
  assert.equal(result.owner_module, '05');
  assert.equal(result.navigation_intent.target.panel_key, 'local-memory');
  assert.equal(result.navigation_intent.scope_generation, 1);
  const operation = actions.getOperation({trusted, operation_ref: 'op-1'});
  assert.equal(operation.state, 'prepared');
  assert.equal(operation.phase, 'intent_ready');
  actions.dispose();
});

test('prepareNavigation denies unregistered scope/module and unavailable owners', async () => {
  const {trusted, actions, registry} = harness({descriptors: []});
  const missing = await actions.prepareNavigation({trusted, module_id: '05', operation_id: 'op-1'});
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.reason_code, 'NOT_READY');

  const {trusted: trusted07, actions: actions07} = harness({descriptors: []});
  assert.equal((await actions07.prepareNavigation({trusted: trusted07, module_id: '06', operation_id: 'op-2'})).reason_code, 'MODULE_DENIED');
  const denied = await actions.prepareNavigation({trusted: {...trusted, caller_ref: 'missing-context'}, module_id: '05', operation_id: 'op-3'});
  assert.equal(denied.status, 'denied');
  assert.equal(denied.reason_code, 'CONTEXT_UNBOUND');
  registry.dispose();
  actions.dispose();
  actions07.dispose();
});

function transformPlan(transform) {
  return customDescriptor(fixtureManifest('05'), {
    compositionDigest: COMPOSITION,
    onPlanOpen: async (trusted) => transform(await descriptor05().planOpen(trusted)),
  });
}

test('malformed or stale intents are mapped to fixed codes without leaking module text', async () => {
  const expired = harness({
    descriptors: [transformPlan((intent) => ({...intent, expires_at: '2020-01-01T00:00:00.000Z'}))],
  });
  const expiredResult = await expired.actions.prepareNavigation({trusted: expired.trusted, module_id: '05', operation_id: 'op-1'});
  assert.equal(expiredResult.status, 'stale');
  assert.equal(expiredResult.reason_code, 'EXPIRED_INTENT');

  const wrongScope = harness({
    descriptors: [transformPlan((intent) => ({...intent, scope_ref: 'scope/other'}))],
  });
  const scopeResult = await wrongScope.actions.prepareNavigation({trusted: wrongScope.trusted, module_id: '05', operation_id: 'op-2'});
  assert.equal(scopeResult.status, 'stale');
  assert.equal(scopeResult.reason_code, 'STALE_SCOPE');

  const escape = harness({
    descriptors: [transformPlan((intent) => ({...intent, target: {kind: 'panel', panel_key: '../escape'}}))],
  });
  const escapeResult = await escape.actions.prepareNavigation({trusted: escape.trusted, module_id: '05', operation_id: 'op-3'});
  assert.equal(escapeResult.status, 'unavailable');
  assert.equal(escapeResult.reason_code, 'INVALID_REQUEST');
  assert.ok(!JSON.stringify(escapeResult).includes('escape'));

  const hostile = harness({
    descriptors: [customDescriptor(fixtureManifest('05'), {compositionDigest: COMPOSITION, onPlanOpen: () => Promise.reject(new Error('C:\\Users\\admin\\.dsh\\.credentials.yaml token=abcd'))})],
  });
  const hostileResult = await hostile.actions.prepareNavigation({trusted: hostile.trusted, module_id: '05', operation_id: 'op-4'});
  assert.equal(hostileResult.status, 'unavailable');
  assert.equal(hostileResult.reason_code, 'INTERNAL_FAILURE');
  assert.ok(!JSON.stringify(hostileResult).includes('credentials'));
  assert.ok(!JSON.stringify(hostileResult).includes('token'));
  for (const item of [expired, wrongScope, escape, hostile]) item.actions.dispose();
});

test('intent ids are single-use and receipts never raise permissions or completion', async () => {
  const {trusted, actions, registry} = harness({descriptors: [descriptor05()]});
  const first = await actions.prepareNavigation({trusted, module_id: '05', operation_id: 'op-1'});
  assert.equal(first.status, 'accepted');
  const duplicate = await actions.prepareNavigation({trusted, module_id: '05', operation_id: 'op-2'});
  assert.equal(duplicate.status, 'unavailable');
  assert.equal(duplicate.reason_code, 'INVALID_REQUEST');

  const revisionBefore = registry.revision;
  const receipt = actions.recordReceipt({trusted, intent_id: first.navigation_intent.intent_id, client_state: 'opened', reason_code: null});
  assert.deepEqual(receipt, {recorded: true});
  assert.equal(registry.revision, revisionBefore);
  const operation = actions.getOperation({trusted, operation_ref: 'op-1'});
  assert.equal(operation.state, 'opened');
  assert.equal(operation.phase, 'client_receipt');

  assert.deepEqual(actions.recordReceipt({trusted, intent_id: 'made-up', client_state: 'opened'}), {recorded: false});
  assert.throws(() => actions.recordReceipt({trusted, intent_id: first.navigation_intent.intent_id, client_state: 'hacked'}));
  const other = harness({descriptors: [descriptor05()]});
  assert.deepEqual(other.actions.recordReceipt({trusted: other.trusted, intent_id: first.navigation_intent.intent_id, client_state: 'opened'}), {recorded: false});
  actions.dispose();
  other.actions.dispose();
  registry.dispose();
});

test('operation.get is context-scoped and reports unknown rather than guessing', async () => {
  const {trusted, actions} = harness({descriptors: [descriptor05()]});
  await actions.prepareNavigation({trusted, module_id: '05', operation_id: 'op-1'});
  const unknown = actions.getOperation({trusted, operation_ref: 'nope'});
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.reason_code, 'UNKNOWN_OPERATION');
  const other = harness({descriptors: [descriptor05()]});
  assert.equal(other.actions.getOperation({trusted: other.trusted, operation_ref: 'op-1'}).state, 'unknown');
  assert.equal(actions.markOperationOutcome('op-1', {state: 'outcome_unknown', phase: 'remote_call'}), true);
  assert.equal(actions.getOperation({trusted, operation_ref: 'op-1'}).state, 'outcome_unknown');
  assert.equal(actions.markOperationOutcome('missing', {state: 'opened', phase: 'x'}), false);
  actions.dispose();
  other.actions.dispose();
});

test('client-authored navigation cannot fabricate a panel that the client is not allowed to see', async () => {
  const {actions, trusted, access, registry} = harness({descriptors: [descriptor05()], moduleIds: ['05']});
  const revoked = access.revokeContext('ctx-one');
  assert.equal(revoked.ok, true);
  const result = await actions.prepareNavigation({trusted, module_id: '05', operation_id: 'op-1'});
  assert.equal(result.status, 'denied');
  assert.equal(result.reason_code, 'SCOPE_REVOKED');
  actions.dispose();
  registry.dispose();
});
