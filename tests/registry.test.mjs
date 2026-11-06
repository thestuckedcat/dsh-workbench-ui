// UI-05 / UI-04: registry ownership, status aggregation, subscriptions and dispose.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRegistry} from '../src/registry.mjs';
import {
  customDescriptor,
  fixtureContext,
  fixtureManifest,
  fixtureManifest as manifestOf,
  trustedFor,
} from './helpers/host-fixtures.mjs';

const manifests = () => [manifestOf('05'), manifestOf('07')];
const context = fixtureContext({modules: ['05', '07']});
const trusted = trustedFor(context);

function descriptorFor(id, overrides) {
  return customDescriptor(manifestOf(id), overrides);
}

test('registry rejects duplicate/invalid catalog data and unsafe composition digests', () => {
  assert.throws(() => createRegistry({catalog: [manifestOf('05'), manifestOf('05')]}));
  assert.throws(() => createRegistry({catalog: [{...manifestOf('05'), id: '08'}]}));
  const registry = createRegistry({catalog: manifests()});
  assert.throws(() => registry.setComposition({ordered: ['99'], composition_digest: 'a'.repeat(64)}));
  assert.throws(() => registry.setComposition({ordered: ['05'], composition_digest: 'not-a-digest'}));
  registry.setComposition({ordered: ['05', '07'], composition_digest: 'e'.repeat(64)});
  assert.equal(registry.compositionDigest(), 'e'.repeat(64));
});

test('descriptor registration is single-owner, in-process and catalog-bound', () => {
  const registry = createRegistry({catalog: manifests()});
  // A serialized/model-provided descriptor is rejected: methods are required.
  assert.throws(() => registry.registerDescriptor({contract_version: 1, id: '05', release_version: '0.0.0-fixture.1', entry: {kind: 'panel', ref: 'local-memory'}}));
  assert.throws(() => registry.registerDescriptor({...descriptorFor('05'), id: '06'}));
  assert.throws(() => registry.registerDescriptor({...descriptorFor('05'), entry: {kind: 'panel', ref: 'other'}}));
  assert.throws(() => registry.registerDescriptor({...descriptorFor('05'), release_version: '9.9.9'}));
  const descriptor = descriptorFor('05');
  const unregister = registry.registerDescriptor(descriptor);
  assert.throws(() => registry.registerDescriptor(descriptorFor('05')));
  unregister();
  unregister();
  const replacement = descriptorFor('05');
  const unregisterReplacement = registry.registerDescriptor(replacement);
  assert.equal(registry.descriptorFor('05'), replacement);
  unregisterReplacement();
  registry.dispose();
});

test('snapshot returns blocked cards for missing owners and rejects invalid status output', async () => {
  const registry = createRegistry({catalog: manifests()});
  registry.setComposition({ordered: ['05', '07'], composition_digest: 'e'.repeat(64)});
  const before = await registry.snapshot(trusted, {context_ref: context.access.context_ref});
  assert.equal(before.changed, true);
  assert.equal(before.modules.length, 2);
  assert.equal(before.modules[0].state, 'blocked');
  assert.equal(before.modules[0].reason_code, 'NOT_READY');

  registry.registerDescriptor(descriptorFor('05'));
  registry.registerDescriptor(customDescriptor(manifestOf('07'), {status: {state: 'ready', reason_code: null, capabilities: [], active_operations: []}, onStatus: () => ({schema_version: 1, module_id: '07', scope_ref: 'scope/other', session_ref: null, generation: 1, revision: 2, state: 'ready', reason_code: null, active_operations: [], updated_at: '2026-11-07T00:00:00.000Z', capabilities: []})}));
  const after = await registry.snapshot(trusted, {context_ref: context.access.context_ref, after_revision: before.revision});
  assert.equal(after.changed, true);
  assert.equal(after.modules.find((module) => module.module_id === '05').state, 'ready');
  const mismatch = after.modules.find((module) => module.module_id === '07');
  assert.equal(mismatch.state, 'blocked');
  assert.equal(mismatch.reason_code, 'STALE_SCOPE');
  assert.ok(after.diagnostics.some((diagnostic) => diagnostic.code === 'DESCRIPTOR_SCOPE_MISMATCH' && diagnostic.severity === 'error'));
  registry.dispose();
});

test('descriptor subscriptions are registered once per context generation and replaced on generation change', async () => {
  const registry = createRegistry({catalog: manifests()});
  registry.setComposition({ordered: ['05', '07'], composition_digest: 'e'.repeat(64)});
  const descriptor05 = descriptorFor('05');
  const descriptor07 = descriptorFor('07');
  registry.registerDescriptor(descriptor05);
  registry.registerDescriptor(descriptor07);
  await registry.snapshot(trusted, {context_ref: context.access.context_ref});
  await registry.snapshot(trusted, {context_ref: context.access.context_ref});
  assert.equal(descriptor05.listenerCount, 1);
  assert.equal(descriptor07.listenerCount, 1);

  const nextGeneration = {...trusted, scope_generation: 2};
  await registry.snapshot(nextGeneration, {context_ref: context.access.context_ref, after_revision: 0});
  assert.equal(descriptor05.listenerCount, 1);
  await registry.snapshot(nextGeneration, {context_ref: context.access.context_ref});
  assert.equal(descriptor05.listenerCount, 1);
  registry.dispose();
  assert.equal(descriptor05.listenerCount, 0);
  assert.equal(descriptor07.listenerCount, 0);
});

test('status subscription updates bump the aggregate revision and after_revision short-circuits', async () => {
  const registry = createRegistry({catalog: manifests()});
  registry.setComposition({ordered: ['05'], composition_digest: 'e'.repeat(64)});
  const descriptor = descriptorFor('05');
  registry.registerDescriptor(descriptor);
  const first = await registry.snapshot(trusted, {context_ref: context.access.context_ref});
  const unchanged = await registry.snapshot(trusted, {context_ref: context.access.context_ref, after_revision: first.revision});
  assert.deepEqual(unchanged, {changed: false, revision: first.revision, modules: [], diagnostics: []});
  const revisionBefore = registry.revision;
  descriptor.emit({state: 'attention', reason_code: null});
  assert.ok(registry.revision > revisionBefore);
  const changed = await registry.snapshot(trusted, {context_ref: context.access.context_ref, after_revision: first.revision});
  assert.equal(changed.changed, true);
  assert.equal(changed.modules[0].state, 'attention');
  registry.dispose();
});

test('quiesce maps descriptor answers to idle/busy/unknown without inventing completion', async () => {
  const registry = createRegistry({catalog: manifests()});
  const descriptor = descriptorFor('05');
  registry.registerDescriptor(descriptor);
  assert.deepEqual(await registry.quiesceModule('05'), {status: 'idle'});
  descriptor.quiesce = () => Promise.resolve({status: 'busy'});
  assert.deepEqual(await registry.quiesceModule('05'), {status: 'busy'});
  descriptor.quiesce = () => Promise.reject(new Error('remote timeout'));
  assert.equal((await registry.quiesceModule('05')).status, 'unknown');
  descriptor.quiesce = () => Promise.resolve({status: 'whatever'});
  assert.equal((await registry.quiesceModule('05')).status, 'unknown');
  assert.equal((await registry.quiesceModule('07')).reason_code, 'NOT_READY');
  registry.dispose();
});

test('dispose releases subscriptions and makes further snapshots fail closed', async () => {
  const registry = createRegistry({catalog: manifests()});
  const descriptor = descriptorFor('05');
  registry.registerDescriptor(descriptor);
  await registry.snapshot(trusted, {context_ref: context.access.context_ref});
  registry.dispose();
  await assert.rejects(() => registry.snapshot(trusted, {context_ref: context.access.context_ref}));
  assert.equal(descriptor.listenerCount, 0);
  registry.dispose();
});

test('service shape probe and allowed module filtering stay catalog-bound', async () => {
  const registry = createRegistry({catalog: manifests()});
  const contextWithOne = fixtureContext({modules: ['05']});
  assert.deepEqual(registry.allowedFrom(contextWithOne.access, undefined), ['05']);
  assert.deepEqual(registry.allowedFrom(contextWithOne.access, '07'), []);
  assert.deepEqual(registry.allowedFrom(contextWithOne.access, '05'), ['05']);
  assert.equal(registry.catalogEntry('07').id, '07');
  assert.equal(registry.catalogEntry('08'), null);
  assert.deepEqual(registry.moduleIds().sort(), ['05', '07']);
  registry.dispose();
});
