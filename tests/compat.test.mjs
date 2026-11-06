// T1 / UI-01: pinned baseline, strict contracts, source-lock and compat gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {
  HOST_BASELINE,
  ContractError,
  canonicalJson,
  decodedJsonBytes,
  digestOf,
  validateModuleManifest,
  validateModuleStatusV1,
  validateNavigationIntentV1,
  validateBusinessResponseV1,
  validateRpcRequestV1,
  validateAccessRegistryV1,
  validateDiagnostic,
  validateProfileV1,
} from '../src/contracts.mjs';
import {
  HOST_FACTS_V1,
  checkModuleHostCompat,
  compareVersions,
  satisfies,
  validateSourceLock,
  verifyHostDigests,
  verifyHostSeams,
  verifySourceLock,
  semver,
} from '../src/compat.mjs';
import {readArchiveHeader, readEntry} from '../tools/host-rc5/asar.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = join(ROOT, 'runtime', 'node.exe');
const ARCHIVE = 'E:/dsh/resources/app.asar';
const EXECUTABLE = 'E:/dsh/DeepSeek Harness.exe';
const SHA = 'a'.repeat(64);

function goodManifest(overrides = {}) {
  const base = {
    schema_version: 1,
    id: '05',
    name: 'Synthetic memory fixture',
    release_version: '0.0.0-fixture.1',
    artifact_ref: 'fixtures/05',
    sha256: 'b'.repeat(64),
    host: {
      verified_versions: [HOST_BASELINE.version],
      declared_range: '>=0.2.0-rc.2 <0.2.2',
      services: [{name: 'session', shape_revision: 'v1'}],
    },
    requires: [],
    provides: {
      tools: [{name: 'fixture_memory_recall', operation_kind: 'read'}],
      slots: [{name: 'main', key: 'local-memory', mode: 'keyed'}],
      writers: [{resource: 'memory.store', scope: 'scope'}],
      hooks: [{name: 'memory/recall', mode: 'observe'}],
    },
    network: {mode: 'none', target_refs: []},
    dispose: {supports_quiesce: true, timeout_ms: 5000},
    entry: {kind: 'panel', ref: 'local-memory'},
    evidence: {
      release_ref: 'fixture/05/release',
      contract_tests_ref: 'fixture/05/contract-tests',
      host_smoke_ref: 'fixture/05/host-smoke',
      network_ref: 'fixture/05/network',
    },
  };
  return {...base, ...overrides};
}

test('strict module manifest validator accepts a complete v1 manifest and rejects deviations', () => {
  const manifest = validateModuleManifest(goodManifest());
  assert.equal(manifest.id, '05');
  for (const [label, mutate] of [
    ['unknown field', (value) => ({...value, extra: true})],
    ['missing field', (value) => {
      const copy = {...value};
      delete copy.release_version;
      return copy;
    }],
    ['bad sha', (value) => ({...value, sha256: 'xyz'})],
    ['network none with targets', (value) => ({...value, network: {mode: 'none', target_refs: ['trusted/one']}})],
    ['future manifest id 08', (value) => ({...value, id: '08'})],
    ['tool name too long', (value) => ({...value, provides: {...value.provides, tools: [{name: 'x'.repeat(200), operation_kind: 'read'}]}})],
  ]) {
    assert.throws(() => validateModuleManifest(mutate(goodManifest())), ContractError, label);
  }
});

test('locked baseline accepts rc.5 and rejects future/unknown hosts', () => {
  const manifest = goodManifest();
  assert.deepEqual(checkModuleHostCompat(manifest, '0.2.1-rc.5'), {status: 'compatible', reason_code: null, detail: null});
  assert.equal(checkModuleHostCompat(manifest, '0.2.2-alpha.3').status, 'needs_verification');
  assert.equal(checkModuleHostCompat(manifest, '0.2.0-rc.1').status, 'needs_verification');
  const narrow = goodManifest({host: {...manifest.host, declared_range: '>=0.2.2-alpha.3'}});
  assert.equal(checkModuleHostCompat(narrow, '0.2.1-rc.5').status, 'needs_verification');
  const unknownVerified = goodManifest({host: {...manifest.host, verified_versions: ['0.2.0-rc.1']}});
  assert.equal(checkModuleHostCompat(unknownVerified, '0.2.1-rc.5').status, 'needs_verification');
});

test('vendored semver is the pinned version and compares prereleases correctly', () => {
  assert.equal(semver.SEMVER_SPEC_VERSION, '2.0.0');
  assert.ok(compareVersions('0.2.2-alpha.3', '0.2.1-rc.5') > 0);
  assert.ok(compareVersions('0.2.1-rc.5', '0.2.1-rc.4') > 0);
  assert.equal(satisfies('0.2.1-rc.5', '>=0.2.0-rc.2 <0.2.2'), true);
  assert.equal(satisfies('0.2.1-rc.5', '>=0.2.2-alpha.3'), false);
});

test('action, status, intent, access and profile contracts reject malformed shapes', () => {
  const status = {
    schema_version: 1,
    module_id: '05',
    scope_ref: 'scope/one',
    session_ref: null,
    generation: 1,
    revision: 2,
    state: 'ready',
    reason_code: null,
    active_operations: [],
    updated_at: '2026-11-07T00:00:00.000Z',
    capabilities: ['memory.recall'],
  };
  assert.doesNotThrow(() => validateModuleStatusV1(status));
  assert.throws(() => validateModuleStatusV1({...status, state: 'hacked'}), ContractError);
  assert.throws(() => validateModuleStatusV1({...status, extra: 1}), ContractError);
  assert.throws(() => validateModuleStatusV1({...status, updated_at: 'yesterday'}), ContractError);

  const intent = {
    schema_version: 1,
    intent_id: 'intent-1',
    operation_id: 'op-1',
    owner_module: '05',
    scope_ref: 'scope/one',
    scope_generation: 1,
    context_revision: 'ctx-1',
    module_revision: 1,
    composition_digest: SHA,
    expires_at: '2026-11-07T00:00:30.000Z',
    target: {kind: 'panel', panel_key: 'local-memory'},
  };
  assert.doesNotThrow(() => validateNavigationIntentV1(intent));
  assert.throws(() => validateNavigationIntentV1({...intent, target: {kind: 'panel', panel_key: '../escape'}}), ContractError);
  assert.throws(() => validateNavigationIntentV1({...intent, target: {kind: 'shell', command: 'rm -rf /'}}), ContractError);
  assert.throws(() => validateNavigationIntentV1({...intent, extra: 'x'}), ContractError);

  assert.doesNotThrow(() => validateAccessRegistryV1({
    schema_version: 1,
    revision: 1,
    contexts: [{context_ref: 'ctx-one', scope_ref: 'scope/one', scope_generation: 1, session_ref: null, allowed_module_ids: ['05'], active: true}],
    profile_refs: ['profiles/desktop'],
  }));
  assert.throws(() => validateAccessRegistryV1({
    schema_version: 1,
    revision: 1,
    contexts: [{context_ref: '../escape', scope_ref: 'scope/one', scope_generation: 1, session_ref: null, allowed_module_ids: ['05'], active: true}],
    profile_refs: ['profiles/desktop'],
  }), ContractError);

  assert.doesNotThrow(() => validateProfileV1({
    schema_version: 1,
    profile_id: 'desktop',
    revision: 2,
    host_version: '0.2.1-rc.5',
    module_refs: [{id: '05', sha256: SHA}],
    policy_ref: 'policy/local',
    policy_digest: SHA,
    composition_digest: SHA,
  }));
  assert.throws(() => validateProfileV1({
    schema_version: 1,
    profile_id: 'desktop',
    revision: 2,
    host_version: '0.2.1-rc.4',
    module_refs: [],
    policy_ref: 'policy/local',
    policy_digest: SHA,
    composition_digest: SHA,
  }), ContractError);
});

test('RPC shell and business response enforce sizes, success/failure split and reason codes', () => {
  const request = {
    schema_version: 1,
    operation_id: 'op-1',
    context_ref: 'ctx-one',
    expected_scope_generation: 1,
    view_epoch: 0,
    input: {},
  };
  assert.doesNotThrow(() => validateRpcRequestV1(request));
  assert.throws(() => validateRpcRequestV1({...request, input: {blob: 'x'.repeat(70 * 1024)}}), ContractError);
  assert.throws(() => validateRpcRequestV1({...request, view_epoch: -1}), ContractError);

  assert.doesNotThrow(() => validateBusinessResponseV1({schema_version: 1, operation_id: 'op-1', view_epoch: 0, scope_generation: 1, status: 'ok', data: {}}));
  assert.doesNotThrow(() => validateBusinessResponseV1({schema_version: 1, operation_id: 'op-1', view_epoch: 0, scope_generation: 1, status: 'denied', reason_code: 'OWNER_REQUIRED'}));
  assert.throws(() => validateBusinessResponseV1({schema_version: 1, operation_id: 'op-1', view_epoch: 0, scope_generation: 1, status: 'ok', data: {}, reason_code: null}), ContractError);
  assert.throws(() => validateBusinessResponseV1({schema_version: 1, operation_id: 'op-1', view_epoch: 0, scope_generation: 1, status: 'failed', reason_code: 'NOT_A_CODE'}), ContractError);
  assert.throws(() => validateBusinessResponseV1({schema_version: 1, operation_id: 'op-1', view_epoch: 0, scope_generation: 1, status: 'failed', data: {}}), ContractError);

  const diagnostic = {code: 'TOOL_CONFLICT', severity: 'error', module_ids: ['05', '07'], resource_ref: 'memory.store', message_key: 'workbench.diagnostic.tool_conflict'};
  assert.doesNotThrow(() => validateDiagnostic(diagnostic));
  assert.throws(() => validateDiagnostic({...diagnostic, severity: 'fatal'}), ContractError);
  assert.throws(() => validateDiagnostic({...diagnostic, stack: 'C:\\secret\\path'}), ContractError);
});

test('canonical JSON digests are key-order independent and reject non-finite numbers', () => {
  assert.equal(canonicalJson({b: 2, a: 1}), '{"a":1,"b":2}');
  assert.equal(digestOf({a: 1, b: [2, 3]}), digestOf({b: [2, 3], a: 1}));
  assert.notEqual(digestOf({a: 1}), digestOf({a: 2}));
  assert.throws(() => canonicalJson({value: Number.NaN}), ContractError);
  assert.ok(decodedJsonBytes({a: 1}) > 0);
});

test('source-lock validates strictly and verifies the checked-in artifact bytes', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'source-lock.json'), 'utf8'));
  validateSourceLock(lock);
  const report = verifySourceLock(lock, {root: ROOT});
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.ok(lock.artifacts.length > 10);
  assert.ok(lock.artifacts.some((artifact) => artifact.path === 'src/contracts.mjs'));
  assert.ok(lock.artifacts.some((artifact) => artifact.path.startsWith('vendor/semver/')));
  assert.equal(lock.host.version, '0.2.1-rc.5');
  assert.equal(lock.host.asar_sha256, HOST_BASELINE.app_asar_sha256);

  const tampered = JSON.parse(JSON.stringify(lock));
  tampered.artifacts[0].sha256 = 'c'.repeat(64);
  assert.equal(verifySourceLock(tampered, {root: ROOT}).ok, false);
  assert.throws(() => validateSourceLock({...lock, unknown_field: 1}), ContractError);
  assert.throws(() => validateSourceLock({...lock, artifacts: []}), ContractError);
});

test('pinned rc.5 archive digests and reviewed seams match the frozen baseline', {skip: !existsSync(ARCHIVE) || !existsSync(EXECUTABLE)}, () => {
  const digests = verifyHostDigests({asarPath: ARCHIVE, executablePath: EXECUTABLE});
  assert.equal(digests.ok, true, JSON.stringify(digests.failures));
  const {header, dataOffset} = readArchiveHeader(ARCHIVE);
  const seams = verifyHostSeams({readAsarFile: (path) => readEntry(ARCHIVE, header, dataOffset, path)});
  assert.equal(seams.ok, true, JSON.stringify(seams.failures));
  assert.equal(seams.files.length, HOST_FACTS_V1.files.length);
  // A tampered source must fail the same probe path (negative control).
  const tampered = verifyHostSeams({readAsarFile: (path) => Buffer.from(`/* not the reviewed source: ${path} */`) });
  assert.equal(tampered.ok, false);
  const missing = verifyHostSeams({readAsarFile: () => {
    throw new Error('missing');
  }});
  assert.equal(missing.ok, false);
});

test('rc.5 seamed files keep the design-doc digests (layout/renderer/connection)', () => {
  const expected = new Map(HOST_FACTS_V1.files.map((row) => [row.path, row.sha256]));
  assert.equal(expected.get('dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js'), 'eb011a7b5699fac7f3ad0aa15408f46a6cf47f79b8cc15db1f81739e81e70587');
  assert.equal(expected.get('dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js'), 'dbdb3f26bfbc1d143bc8a0eed5982a2507c4f0cf8027e7c170f3bed3604be356');
  assert.equal(expected.get('dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js'), '0ebcca7583e082716f79b0b55bc1749d48269cc8db2989b043b321b57abd3684');
  assert.equal(expected.get('dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/client.browser.js'), 'dfc3544eb894c74b340a4c4c63a8c125fd2e983df9efed5885712574af994e62');
});

test('doctor exits 0 for the pinned isolated baseline', {skip: !existsSync(RUNTIME) || !existsSync(ARCHIVE)}, () => {
  const result = spawnSync(RUNTIME, [join(ROOT, 'tools', 'doctor.mjs'), '--isolated', '--host', '0.2.1-rc.5'], {cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.mode, 'isolated-read-only');
  assert.equal(report.checks.seams.ok, true);
  assert.equal(report.checks.source_lock.ok, true);
  assert.equal(report.checks.runtime.ok, true);
});

test('doctor rejects an unpinned host with needs_verification', {skip: !existsSync(RUNTIME) || !existsSync(ARCHIVE)}, () => {
  const result = spawnSync(RUNTIME, [join(ROOT, 'tools', 'doctor.mjs'), '--isolated', '--host', '0.2.2-alpha.3'], {cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true});
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.host_gate.status, 'needs_verification');
});
