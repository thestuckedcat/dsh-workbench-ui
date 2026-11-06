// T2 / UI-02: conflict inspection tests.
//
// Conflict detection runs on the selected manifests only. Two owners of one
// tool/slot/writer/exclusive hook block the composition; observe hooks may
// coexist (informational); output order is deterministic for equal inputs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ContractError, HOST_BASELINE, PREFERRED_ORDER, validateDiagnostic} from '../src/contracts.mjs';
import {inspectConflicts} from '../src/conflicts.mjs';
import {resolveComposition} from '../src/resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_FILE = JSON.parse(readFileSync(join(ROOT, 'profile', 'components.json'), 'utf8'));
const FIXTURES = CATALOG_FILE.modules;
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha = (text) => createHash('sha256').update(text).digest('hex');

function fixture(id) {
  const found = FIXTURES.find((manifest) => manifest.id === id);
  assert.ok(found, `fixture ${id} must exist`);
  return clone(found);
}

function variant(id, overrides = {}) {
  const base = fixture(id === '07' ? '07' : '05');
  return {
    ...base,
    ...overrides,
    id,
    name: `${id} fixture variant`,
    artifact_ref: `fixture/${id}-variant`,
    sha256: sha(`fixture/${id}-variant`),
    evidence: {
      release_ref: `fixture/${id}/release`,
      contract_tests_ref: `fixture/${id}/contract-tests`,
      host_smoke_ref: `fixture/${id}/host-smoke`,
      network_ref: `fixture/${id}/network`,
    },
  };
}

function withProvides(manifest, overrides) {
  return {...manifest, provides: {...manifest.provides, ...overrides}};
}

function resolveTwo(left, right) {
  const catalog = [left, right];
  const locks = Object.fromEntries(catalog.map((manifest) => [manifest.id, manifest.sha256]));
  return resolveComposition({
    host: {version: HOST_BASELINE.version},
    requested_modules: [left.id, right.id],
    locks,
    policy: {network_mode: 'none', allowed_target_refs: [], allowed_module_ids: [left.id, right.id]},
    catalog,
  });
}

function errorDiagnostics(diagnostics) {
  return diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
}

test('two writers of one resource conflict, including global vs narrower scope', () => {
  const memory = fixture('05');
  const context = withProvides(fixture('07'), {writers: [{resource: 'memory/store', scope: 'scope'}]});
  const diagnostics = inspectConflicts([memory, context]);
  const conflict = diagnostics.find((diagnostic) => diagnostic.code === 'WRITER_CONFLICT');
  assert.ok(conflict);
  assert.equal(conflict.severity, 'error');
  assert.deepEqual(conflict.module_ids, ['05', '07']);
  assert.equal(conflict.resource_ref, 'writer/memory/store');

  const resolved = resolveTwo(memory, context);
  assert.equal(resolved.status, 'blocked');
  assert.ok(resolved.diagnostics.some((diagnostic) => diagnostic.code === 'WRITER_CONFLICT'));
});

test('two global writers of one resource conflict', () => {
  const left = fixture('05');
  const right = withProvides(fixture('07'), {writers: [{resource: 'memory/store', scope: 'global'}]});
  const diagnostics = inspectConflicts([left, right]);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'WRITER_CONFLICT'));
});

test('two modules registering the same tool name conflict', () => {
  const memory = fixture('05');
  const context = withProvides(fixture('07'), {
    tools: [
      {name: 'context_observe', operation_kind: 'read'},
      {name: 'memory_search', operation_kind: 'read'},
    ],
  });
  const diagnostics = inspectConflicts([memory, context]);
  const conflict = diagnostics.find((diagnostic) => diagnostic.code === 'TOOL_CONFLICT');
  assert.ok(conflict);
  assert.deepEqual(conflict.module_ids, ['05', '07']);
  assert.equal(conflict.resource_ref, 'tool/memory_search');
  assert.ok(resolveTwo(memory, context).status === 'blocked');
});

test('two single-mode slots with the same name conflict', () => {
  const memory = withProvides(fixture('05'), {slots: [{name: 'dock', key: null, mode: 'single'}]});
  const context = withProvides(fixture('07'), {slots: [{name: 'dock', key: null, mode: 'single'}]});
  const diagnostics = inspectConflicts([memory, context]);
  const conflict = diagnostics.find((diagnostic) => diagnostic.code === 'SLOT_CONFLICT');
  assert.ok(conflict);
  assert.equal(conflict.message_key, 'conflict.slot_single_duplicate');
  assert.deepEqual(conflict.module_ids, ['05', '07']);
});

test('mixing single and keyed modes on one slot name conflicts', () => {
  const memory = withProvides(fixture('05'), {slots: [{name: 'dock', key: null, mode: 'single'}]});
  const context = withProvides(fixture('07'), {slots: [{name: 'dock', key: 'local-context', mode: 'keyed'}]});
  const conflict = inspectConflicts([memory, context]).find((diagnostic) => diagnostic.code === 'SLOT_CONFLICT');
  assert.ok(conflict);
  assert.equal(conflict.message_key, 'conflict.slot_mode_mismatch');
});

test('keyed slots conflict on the same name+key but coexist on distinct keys', () => {
  const memory = withProvides(fixture('05'), {slots: [{name: 'main', key: 'shared', mode: 'keyed'}]});
  const colliding = withProvides(fixture('07'), {slots: [{name: 'main', key: 'shared', mode: 'keyed'}]});
  const conflict = inspectConflicts([memory, colliding]).find((diagnostic) => diagnostic.code === 'SLOT_CONFLICT');
  assert.ok(conflict);
  assert.equal(conflict.message_key, 'conflict.slot_keyed_key_duplicate');
  assert.equal(conflict.resource_ref, 'slot/main/shared');

  const distinct = withProvides(fixture('07'), {slots: [{name: 'main', key: 'local-context', mode: 'keyed'}]});
  assert.deepEqual(inspectConflicts([memory, distinct]), []);
});

test('list slots conflict on the same name+key but coexist on distinct keys', () => {
  const left = withProvides(fixture('05'), {slots: [{name: 'dock', key: 'status', mode: 'list'}]});
  const colliding = withProvides(fixture('07'), {slots: [{name: 'dock', key: 'status', mode: 'list'}]});
  const conflict = inspectConflicts([left, colliding]).find((diagnostic) => diagnostic.code === 'SLOT_CONFLICT');
  assert.ok(conflict);
  assert.equal(conflict.message_key, 'conflict.slot_list_key_duplicate');

  const distinct = withProvides(fixture('07'), {slots: [{name: 'dock', key: 'activity', mode: 'list'}]});
  assert.deepEqual(inspectConflicts([left, distinct]), []);
});

test('two exclusive_mutate hooks on one name conflict', () => {
  const left = withProvides(fixture('05'), {hooks: [{name: 'turn.before', mode: 'exclusive_mutate'}]});
  const right = withProvides(fixture('07'), {hooks: [{name: 'turn.before', mode: 'exclusive_mutate'}]});
  const diagnostics = inspectConflicts([left, right]);
  const conflict = diagnostics.find((diagnostic) => diagnostic.code === 'HOOK_CONFLICT');
  assert.ok(conflict);
  assert.equal(conflict.severity, 'error');
  assert.deepEqual(conflict.module_ids, ['05', '07']);
  assert.equal(resolveTwo(left, right).status, 'blocked');
});

test('observe hooks coexist and only produce an informational diagnostic', () => {
  const left = withProvides(fixture('05'), {hooks: [{name: 'turn.after', mode: 'observe'}]});
  const right = withProvides(fixture('07'), {hooks: [{name: 'turn.after', mode: 'observe'}]});
  const diagnostics = inspectConflicts([left, right]);
  assert.equal(errorDiagnostics(diagnostics).length, 0);
  const info = diagnostics.find((diagnostic) => diagnostic.code === 'OBSERVE_COEXIST');
  assert.ok(info);
  assert.equal(info.severity, 'info');
  assert.deepEqual(info.module_ids, ['05', '07']);
  assert.equal(resolveTwo(left, right).status, 'valid');
});

test('a single exclusive mutator coexists with observers of the same hook', () => {
  const observer = withProvides(fixture('05'), {hooks: [{name: 'turn.after', mode: 'observe'}]});
  const mutator = withProvides(fixture('07'), {hooks: [{name: 'turn.after', mode: 'exclusive_mutate'}]});
  const diagnostics = inspectConflicts([observer, mutator]);
  assert.equal(errorDiagnostics(diagnostics).length, 0);
  assert.deepEqual(diagnostics, []);
});

test('conflict diagnostics are deterministic and sorted for shuffled input', () => {
  const left = withProvides(fixture('05'), {
    hooks: [{name: 'turn.before', mode: 'exclusive_mutate'}],
    writers: [{resource: 'shared/store', scope: 'global'}],
    tools: [{name: 'shared_tool', operation_kind: 'read'}],
  });
  const right = withProvides(fixture('07'), {
    hooks: [{name: 'turn.before', mode: 'exclusive_mutate'}],
    writers: [{resource: 'shared/store', scope: 'scope'}],
    tools: [{name: 'shared_tool', operation_kind: 'write'}],
  });
  const forward = inspectConflicts([left, right]);
  const backward = inspectConflicts([right, left]);
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward.map((diagnostic) => diagnostic.code), ['HOOK_CONFLICT', 'TOOL_CONFLICT', 'WRITER_CONFLICT']);
  for (const diagnostic of forward) validateDiagnostic(diagnostic);
});

test('conflicts are detected only among the selected modules', () => {
  const memory = fixture('05');
  const conflicting = withProvides(fixture('07'), {
    hooks: [{name: 'turn.before', mode: 'exclusive_mutate'}],
    writers: [{resource: 'memory/store', scope: 'scope'}],
  });
  const catalog = [memory, conflicting];
  const locks = Object.fromEntries(catalog.map((manifest) => [manifest.id, manifest.sha256]));
  const result = resolveComposition({
    host: {version: HOST_BASELINE.version},
    requested_modules: ['05'],
    locks,
    policy: {network_mode: 'none', allowed_target_refs: [], allowed_module_ids: ['05', '07']},
    catalog,
  });
  assert.equal(result.status, 'valid');
  assert.deepEqual(result.enabled, ['05']);
  assert.deepEqual(result.diagnostics, []);
});

test('a dependency cycle blocks all participating modules through the resolver', () => {
  const memory = variant('05', {requires: [{module_id: '07', contract_major: 1, optional: false}]});
  const context = variant('07', {requires: [{module_id: '05', contract_major: 1, optional: false}]});
  const result = resolveTwo(memory, context);
  assert.equal(result.status, 'blocked');
  const cycle = result.diagnostics.find((diagnostic) => diagnostic.code === 'DEPENDENCY_CYCLE');
  assert.deepEqual(cycle.module_ids, ['05', '07']);
  assert.deepEqual(result.enabled, []);
  assert.deepEqual(result.ordered, []);
});

test('module order and digest stay stable for equivalent inputs', () => {
  const catalog = [fixture('05'), fixture('07')];
  const locks = Object.fromEntries(catalog.map((manifest) => [manifest.id, manifest.sha256]));
  const run = (requested, reversed) => resolveComposition({
    host: {version: HOST_BASELINE.version},
    requested_modules: requested,
    locks,
    policy: {network_mode: 'none', allowed_target_refs: [], allowed_module_ids: ['05', '07']},
    catalog: reversed ? [...catalog].reverse() : catalog,
  });
  const first = run(['05', '07'], false);
  const second = run(['07', '05'], true);
  assert.deepEqual(first.ordered, second.ordered);
  assert.equal(first.composition_digest, second.composition_digest);
  assert.deepEqual(first.ordered, [...PREFERRED_ORDER].filter((id) => id === '05' || id === '07'));
});

test('inspectConflicts rejects an invalid manifest instead of guessing', () => {
  const invalid = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'modules', 'invalid-missing-network.json'), 'utf8'));
  assert.throws(() => inspectConflicts([invalid]), (error) => error instanceof ContractError);
});
