// T2 / UI-02: composition resolver tests.
//
// Every negative case must name the module owners involved and stay
// deterministic: no auto-enable, no inferred compatibility, no network, and a
// composition digest that only depends on the ordered module id/sha pairs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  ContractError,
  HOST_BASELINE,
  PREFERRED_ORDER,
  digestOf,
  validateDiagnostic,
  validateResolveResult,
} from '../src/contracts.mjs';
import {compositionDigest, resolveComposition} from '../src/resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_FILE = JSON.parse(readFileSync(join(ROOT, 'profile', 'components.json'), 'utf8'));
const FIXTURES = CATALOG_FILE.modules;

const clone = (value) => JSON.parse(JSON.stringify(value));
const sha = (text) => createHash('sha256').update(text).digest('hex');
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'modules');

function fixture(id) {
  const found = FIXTURES.find((manifest) => manifest.id === id);
  assert.ok(found, `fixture ${id} must exist in profile/components.json`);
  return clone(found);
}

/** Valid v1 manifest derived from a catalog fixture, with field overrides. */
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

const HOST = {version: HOST_BASELINE.version};

const policyFor = (ids, extra = {}) => ({
  network_mode: 'none',
  allowed_target_refs: [],
  allowed_module_ids: [...ids],
  ...extra,
});

const locksFor = (manifests) => Object.fromEntries(manifests.map((manifest) => [manifest.id, manifest.sha256]));

function resolveWith({
  catalog,
  requested,
  host = HOST,
  policy = policyFor(requested),
  locks = locksFor(catalog),
} = {}) {
  return resolveComposition({host, requested_modules: requested, locks, policy, catalog});
}

function codes(result) {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function readFixtureFile(name) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

test('rc.5 fixture catalog resolves 05 then 07 with a stable digest', () => {
  const catalog = [fixture('05'), fixture('07')];
  const result = resolveWith({catalog, requested: ['05', '07']});
  validateResolveResult(result);
  assert.equal(result.status, 'valid');
  assert.deepEqual(result.ordered, ['05', '07']);
  assert.deepEqual(result.enabled, ['05', '07']);
  assert.deepEqual(result.disabled, []);
  assert.deepEqual(result.diagnostics, []);
  const expectedDigest = digestOf({
    schema_version: 1,
    host_version: HOST_BASELINE.version,
    modules: catalog.map((manifest) => ({id: manifest.id, sha256: manifest.sha256})),
  });
  assert.equal(result.composition_digest, expectedDigest);
  assert.equal(result.composition_digest, compositionDigest(HOST_BASELINE.version, catalog));
});

test('request order does not change order or digest', () => {
  const catalog = [fixture('05'), fixture('07')];
  const forward = resolveWith({catalog, requested: ['05', '07']});
  const backward = resolveWith({catalog: [...catalog].reverse(), requested: ['07', '05']});
  assert.equal(forward.status, 'valid');
  assert.deepEqual(forward.ordered, backward.ordered);
  assert.deepEqual(forward.composition_digest, backward.composition_digest);
});

test('a Host version that is not the pinned baseline is needs_verification and blocked', () => {
  const catalog = [fixture('05'), fixture('07')];
  const result = resolveWith({catalog, requested: ['05'], host: {version: '0.2.2-alpha.3'}});
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.enabled, []);
  assert.ok(codes(result).includes('HOST_INCOMPATIBLE'));
  assert.ok(result.diagnostics.every((diagnostic) => diagnostic.severity === 'error'));
});

test('a manifest that only verified a future Host is blocked on the pinned Host', () => {
  const future = readFixtureFile('incompatible-future-host.json');
  const result = resolveWith({catalog: [future], requested: ['06']});
  assert.equal(result.status, 'blocked');
  assert.ok(codes(result).includes('HOST_INCOMPATIBLE'));
  assert.deepEqual(result.diagnostics.find((diagnostic) => diagnostic.code === 'HOST_INCOMPATIBLE').module_ids, ['06']);
});

test('a lock digest mismatch blocks the module it locks', () => {
  const catalog = [fixture('05')];
  const result = resolveWith({
    catalog,
    requested: ['05'],
    locks: {'05': sha('not-the-locked-bytes')},
  });
  assert.equal(result.status, 'blocked');
  const diagnostic = result.diagnostics.find((entry) => entry.code === 'DIGEST_MISMATCH');
  assert.ok(diagnostic);
  assert.deepEqual(diagnostic.module_ids, ['05']);
  assert.equal(diagnostic.message_key, 'resolve.digest_mismatch');
});

test('a missing lock entry is rejected, never defaulted open', () => {
  const catalog = [fixture('05')];
  const result = resolveWith({catalog, requested: ['05'], locks: {}});
  assert.equal(result.status, 'blocked');
  const diagnostic = result.diagnostics.find((entry) => entry.code === 'DIGEST_MISMATCH');
  assert.equal(diagnostic.message_key, 'resolve.lock_missing');
});

test('an unknown requested module is blocked and named', () => {
  const catalog = [fixture('05'), fixture('07')];
  const result = resolveWith({catalog, requested: ['03'], locks: {}, policy: policyFor(['03'])});
  assert.equal(result.status, 'blocked');
  const unknown = result.diagnostics.find((entry) => entry.code === 'UNKNOWN_MODULE');
  assert.ok(unknown);
  assert.deepEqual(unknown.module_ids, ['03']);
});

test('a missing required dependency blocks and names both modules', () => {
  const memory = variant('05');
  const context = variant('07', {requires: [{module_id: '06', contract_major: 1, optional: false}]});
  const catalog = [memory, context];
  const result = resolveWith({catalog, requested: ['07'], locks: locksFor(catalog), policy: policyFor(['07'])});
  assert.equal(result.status, 'blocked');
  const missing = result.diagnostics.find((entry) => entry.code === 'DEPENDENCY_MISSING');
  assert.ok(missing);
  assert.deepEqual(missing.module_ids, ['06', '07']);
  assert.deepEqual(result.ordered, []);
});

test('a missing optional dependency disables the feature and is never auto-enabled', () => {
  const context = variant('07', {requires: [{module_id: '06', contract_major: 1, optional: true}]});
  const catalog = [context];
  const result = resolveWith({catalog, requested: ['07'], locks: locksFor(catalog), policy: policyFor(['07'])});
  assert.equal(result.status, 'valid');
  assert.deepEqual(result.enabled, ['07']);
  assert.ok(!result.enabled.includes('06'));
  assert.equal(result.disabled.length, 1);
  assert.equal(result.disabled[0].severity, 'warning');
  assert.equal(result.disabled[0].message_key, 'resolve.optional_dependency_missing');
  assert.deepEqual(result.disabled[0].module_ids, ['06', '07']);
});

test('a network policy of none rejects any module that would need a target', () => {
  const memory = variant('05', {network: {mode: 'approved_model', target_refs: ['target/model']}});
  const catalog = [memory];
  const result = resolveWith({catalog, requested: ['05'], locks: locksFor(catalog), policy: policyFor(['05'])});
  assert.equal(result.status, 'blocked');
  assert.ok(codes(result).includes('NETWORK_POLICY'));
});

test('a requested target must already be allow-listed by the local policy', () => {
  const memory = variant('05', {network: {mode: 'trusted_targets', target_refs: ['target/remote']}});
  const catalog = [memory];
  const denied = resolveWith({
    catalog,
    requested: ['05'],
    locks: locksFor(catalog),
    policy: {network_mode: 'trusted_targets', allowed_target_refs: [], allowed_module_ids: ['05']},
  });
  assert.equal(denied.status, 'blocked');
  assert.ok(codes(denied).includes('NETWORK_POLICY'));

  const allowed = resolveWith({
    catalog,
    requested: ['05'],
    locks: locksFor(catalog),
    policy: {network_mode: 'trusted_targets', allowed_target_refs: ['target/remote'], allowed_module_ids: ['05']},
  });
  assert.equal(allowed.status, 'valid');
});

test('a dependency cycle blocks and names every participating module', () => {
  const memory = variant('05', {requires: [{module_id: '07', contract_major: 1, optional: false}]});
  const context = variant('07', {requires: [{module_id: '05', contract_major: 1, optional: false}]});
  const catalog = [memory, context];
  const result = resolveWith({catalog, requested: ['05', '07'], locks: locksFor(catalog), policy: policyFor(['05', '07'])});
  assert.equal(result.status, 'blocked');
  const cycle = result.diagnostics.find((entry) => entry.code === 'DEPENDENCY_CYCLE');
  assert.ok(cycle);
  assert.deepEqual(cycle.module_ids, ['05', '07']);
  assert.deepEqual(result.ordered, []);
});

test('a module denied by the profile policy is blocked', () => {
  const catalog = [fixture('05'), fixture('07')];
  const result = resolveWith({
    catalog,
    requested: ['05', '07'],
    policy: {network_mode: 'none', allowed_target_refs: [], allowed_module_ids: ['05']},
  });
  assert.equal(result.status, 'blocked');
  const denied = result.diagnostics.find((entry) => entry.code === 'MODULE_DENIED');
  assert.ok(denied);
  assert.deepEqual(denied.module_ids, ['07']);
});

test('an empty request resolves to the empty composition', () => {
  const result = resolveWith({catalog: [fixture('05')], requested: [], locks: {}, policy: policyFor([])});
  assert.equal(result.status, 'valid');
  assert.deepEqual(result.ordered, []);
  assert.equal(result.composition_digest, compositionDigest(HOST_BASELINE.version, []));
});

test('invalid catalog manifests are rejected by the strict validator', () => {
  for (const name of ['invalid-missing-network.json', 'invalid-unknown-field.json', 'invalid-network-targets.json']) {
    const invalid = readFixtureFile(name);
    assert.throws(
      () => resolveWith({catalog: [invalid], requested: [invalid.id], locks: {[invalid.id]: invalid.sha256}}),
      (error) => error instanceof ContractError,
      `${name} must be rejected`,
    );
  }
});

test('a manifest may not depend on the 08 composer', () => {
  const invalid = readFixtureFile('invalid-depends-on-composer.json');
  const catalog = [invalid];
  const result = resolveWith({catalog, requested: [invalid.id], locks: locksFor(catalog), policy: policyFor([invalid.id])});
  assert.equal(result.status, 'blocked');
  assert.ok(codes(result).includes('DEPENDENCY_MISSING'));
});

test('every emitted diagnostic satisfies the shared diagnostic contract', () => {
  const memory = variant('05', {requires: [{module_id: '07', contract_major: 1, optional: false}]});
  const context = variant('07', {requires: [{module_id: '05', contract_major: 1, optional: false}]});
  const catalog = [memory, context];
  const result = resolveWith({catalog, requested: ['05', '07'], locks: locksFor(catalog), policy: policyFor(['05', '07'])});
  for (const diagnostic of [...result.diagnostics, ...result.disabled]) validateDiagnostic(diagnostic);
});

test('PREFERRED_ORDER is the frozen module ordering contract', () => {
  assert.deepEqual([...PREFERRED_ORDER], ['05', '07', '06', '03', '04', '02', '01']);
});
