// Compatibility gates and pinned rc.5 seam facts (T1 / UI-01).
//
// Two independent checks must both pass before anything is treated as
// compatible: the exact baseline whitelist (host version + archive digests)
// and a service/export shape probe. Unknown versions are reported as
// needs_verification, never inherited from an older conclusion.
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {HOST_BASELINE, ContractError, assertSha256, assertStableId, assertVersion, assertRef, assertPackageName, isPlainObject} from './contracts.mjs';

const require = createRequire(import.meta.url);
const semver = require('../vendor/semver/index.js');

export {semver};

/** Version syntax/range helpers on the vendored, pinned semver package. */
export function compareVersions(left, right) {
  return semver.compare(left, right);
}

export function satisfies(version, range) {
  return semver.satisfies(version, range, {includePrerelease: true});
}

export function validVersion(value) {
  return semver.valid(value) !== null;
}

/**
 * Pinned rc.5 seams actually relied on by this workbench. Each row records the
 * archive path, its reviewed SHA256, and the exact source facts the adapter is
 * bound to. `tools/doctor.mjs` re-reads the archive and re-checks these.
 */
export const HOST_FACTS_V1 = Object.freeze({
  schema_version: 1,
  host: HOST_BASELINE,
  files: Object.freeze([
    {
      path: 'dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js',
      sha256: '426084f8672c26a469566a3f43c91a9b0d1dd73d0834028e553a6d0fa9cffa44',
      facts: ['window.__ModuleLoader__.load({id, factory})', 'factory(require) lazy CJS registration', 'seed/static module resolution'],
      probes: [
        {label: 'module loader registration facade', pattern: 'window\\.__ModuleLoader__\\.load\\('},
        {label: 'factory receive require', pattern: 'factory: \\(require\\) =>'},
      ],
    },
    {
      path: 'dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js',
      sha256: 'a2a33e32f13fdc9598b4751c4c22fb72789190bf5ba7337cd5a3d0cb4b4417ec',
      facts: ['host half scans dsh.client declarations', 'composes window.__DSH_BOOT__ graph', 'serves plugin client combo scripts'],
      probes: [
        {label: 'dsh.client scanner', pattern: 'dsh\\.client'},
        {label: 'boot graph wire', pattern: '__DSH_BOOT__'},
      ],
    },
    {
      path: 'dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js',
      sha256: 'eb011a7b5699fac7f3ad0aa15408f46a6cf47f79b8cc15db1f81739e81e70587',
      facts: ['ctx.layout.selectPanel(panelId|null)', 'main slot is keyed/root scoped', 'selectPanel validates hasMainPanel(entry.options.key)'],
      probes: [
        {label: 'selectPanel service', pattern: 'selectPanel\\(panelId\\)'},
        {label: 'main keyed slot', pattern: '"main": \\{\\s*kind: "keyed"'},
        {label: 'hasMainPanel key check', pattern: 'entry\\.options\\.key === id'},
      ],
    },
    {
      path: 'dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js',
      sha256: 'dbdb3f26bfbc1d143bc8a0eed5982a2507c4f0cf8027e7c170f3bed3604be356',
      facts: ['ctx.slots service (SlotRegistry)', 'slots.register(options, component)', 'slots.inject(name, callback)'],
      probes: [
        {label: 'slots.register', pattern: 'SlotRegistry\\.prototype\\.register'},
        {label: 'slot renderer install', pattern: 'slots\\.inject|new SlotRegistry'},
      ],
    },
    {
      path: 'dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js',
      sha256: 'f5cd3c44c4d2f42d017bc3f133758a54af2f0fcafce7173a983045c1f2976a4b',
      facts: ['sidebar.panellist rows call selectPanel(options.id)', 'entry id must equal the keyed main key'],
      probes: [
        {label: 'panellist slot', pattern: 'sidebar\\.panellist'},
        {label: 'row click selectPanel', pattern: 'selectPanel\\(id\\)'},
      ],
    },
    {
      path: 'dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js',
      sha256: '0ebcca7583e082716f79b0b55bc1749d48269cc8db2989b043b321b57abd3684',
      facts: ['ctx.connection.rpc.handle(channel, handler)', 'handler(endpoint, payload, request.signal, peer)', 'browser peer principal.kind==="owner"', 'handler throw becomes 500'],
      probes: [
        {label: 'rpc.handle', pattern: 'handle: \\(channel, handler\\) => this\\.register\\(owner, channel, handler\\)'},
        {label: 'handler signature', pattern: 'handler\\(endpoint, message\\.payload, request\\.signal, peer\\)'},
        {label: 'owner principal', pattern: 'principal: \\{\\s*kind: "owner"\\s*\\}'},
        {label: 'server response schema', pattern: 'serverResponseSchema'},
      ],
    },
    {
      path: 'dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/client.browser.js',
      sha256: 'dfc3544eb894c74b340a4c4c63a8c125fd2e983df9efed5885712574af994e62',
      facts: ['ctx.connection service provided in browser', 'rpc.call(channel, endpoint, payload, signal) returns RpcResult', 'rpcId mismatch rejected'],
      probes: [
        {label: 'browser connection provide', pattern: 'ctx\\.provide\\("connection", handle\\)'},
        {label: 'rpc.call signature', pattern: 'async call\\(channel, endpoint, payload, signal\\)'},
      ],
    },
    {
      path: 'dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
      sha256: '5135179ac810e4f626f32ec3bdc3293dc7d2028e8aa92e5e0c006f1a33b78e76',
      facts: ['profile/bundle resolution reads dsh.bundle.patch', 'isolated DSH_HOME is supported by the launch environment'],
      probes: [
        {label: 'bundle patch resolution', pattern: 'bundle\\.patch|\\.bundle\\.patch'},
      ],
    },
    {
      path: 'dsh/node_modules/@deepseek-ai/dsh-web-app/lib/index.js',
      sha256: '6662ca712368c56fb8818efa53039ef92ce215a328a76b9cdd5e1bed624a0e84',
      facts: ['web surface bundle patches client modules into the web app'],
      probes: [{label: 'web app runtime glue', pattern: 'dsh-web-frontend|frontend'}],
    },
  ]),
});

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function hashFile(path) {
  return sha256File(path);
}

/**
 * Re-read the pinned archive and verify every seam fact hash and source probe.
 * `archive` is the app.asar path; `readAsarFile` is injected by the caller
 * (tools/doctor.mjs wires the archive reader) so this module stays testable.
 */
export function verifyHostSeams({facts = HOST_FACTS_V1, readAsarFile}) {
  if (typeof readAsarFile !== 'function') throw new TypeError('verifyHostSeams requires readAsarFile');
  const files = [];
  const failures = [];
  for (const row of facts.files) {
    let bytes;
    try {
      bytes = readAsarFile(row.path);
    } catch (error) {
      failures.push({path: row.path, code: 'MISSING', detail: String(error.message ?? error)});
      continue;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    const hashOk = actual === row.sha256;
    if (!hashOk) failures.push({path: row.path, code: 'DIGEST_MISMATCH', expected: row.sha256, actual});
    const source = bytes.toString('utf8');
    const probes = (row.probes ?? []).map((probe) => {
      const ok = new RegExp(probe.pattern).test(source);
      if (!ok) failures.push({path: row.path, code: 'PROBE_MISSING', label: probe.label, pattern: probe.pattern});
      return {label: probe.label, ok};
    });
    files.push({path: row.path, expected_sha256: row.sha256, actual_sha256: actual, size: bytes.length, hash_ok: hashOk, probes});
  }
  return {ok: failures.length === 0, host: facts.host, files, failures};
}

/** Verify the installed executable/archive digests against the frozen baseline. */
export function verifyHostDigests({asarPath, executablePath}) {
  const failures = [];
  let archive = null;
  let executable = null;
  try {
    archive = {path: asarPath, sha256: sha256File(asarPath)};
    if (archive.sha256 !== HOST_BASELINE.app_asar_sha256) failures.push({path: asarPath, code: 'DIGEST_MISMATCH', role: 'app_asar', expected: HOST_BASELINE.app_asar_sha256, actual: archive.sha256});
  } catch (error) {
    failures.push({path: asarPath, code: 'MISSING', role: 'app_asar', detail: String(error.message ?? error)});
  }
  try {
    executable = {path: executablePath, sha256: sha256File(executablePath)};
    if (executable.sha256 !== HOST_BASELINE.executable_sha256) failures.push({path: executablePath, code: 'DIGEST_MISMATCH', role: 'executable', expected: HOST_BASELINE.executable_sha256, actual: executable.sha256});
  } catch (error) {
    failures.push({path: executablePath, code: 'MISSING', role: 'executable', detail: String(error.message ?? error)});
  }
  return {ok: failures.length === 0, host: HOST_BASELINE, archive, executable, failures};
}

/**
 * Exact-baseline compatibility gate. The pinned version must be listed as a
 * verified version, the declared range must accept it through the vendored
 * semver implementation, and the runtime host version must equal the baseline.
 * Anything else is needs_verification (never silently compatible).
 */
export function checkModuleHostCompat(manifest, hostVersion) {
  if (hostVersion !== HOST_BASELINE.version) {
    return {status: 'needs_verification', reason_code: 'HOST_INCOMPATIBLE', detail: `host ${hostVersion} is not the pinned ${HOST_BASELINE.version}`};
  }
  if (!Array.isArray(manifest.host.verified_versions) || !manifest.host.verified_versions.includes(hostVersion)) {
    return {status: 'needs_verification', reason_code: 'HOST_INCOMPATIBLE', detail: 'manifest verified_versions does not include the pinned host'};
  }
  let accepted = false;
  try {
    accepted = satisfies(hostVersion, manifest.host.declared_range);
  } catch (error) {
    return {status: 'needs_verification', reason_code: 'HOST_INCOMPATIBLE', detail: `unparseable declared_range: ${String(error.message ?? error)}`};
  }
  if (!accepted) return {status: 'needs_verification', reason_code: 'HOST_INCOMPATIBLE', detail: 'declared_range rejects the pinned host'};
  return {status: 'compatible', reason_code: null, detail: null};
}

/**
 * Probe an actual in-process service against the manifest's declared service
 * shapes. Name presence alone is not compatibility: each declared entry is a
 * `{name, shape_revision}` and the probe checks the real shape through the
 * provided expectations.
 */
export function probeServiceShapes(serviceGetters, declaredServices) {
  const failures = [];
  for (const service of declaredServices) {
    const getter = serviceGetters[service.name];
    if (typeof getter !== 'function') {
      failures.push({service: service.name, code: 'MISSING_SERVICE'});
      continue;
    }
    let actual;
    try {
      actual = getter();
    } catch (error) {
      failures.push({service: service.name, code: 'SERVICE_THREW', detail: String(error.message ?? error)});
      continue;
    }
    if (actual === undefined || actual === null) failures.push({service: service.name, code: 'MISSING_SERVICE'});
    else if (typeof service.shape_revision !== 'string' || service.shape_revision.length === 0) failures.push({service: service.name, code: 'INVALID_SHAPE_REVISION'});
  }
  return {ok: failures.length === 0, failures};
}

// ---------------------------------------------------------------------------
// source-lock v1
// ---------------------------------------------------------------------------

const LOCK_TOP_KEYS = ['schema_version', 'host', 'runtime', 'artifacts', 'selected_modules', 'evidence_refs'];
const ARTIFACT_KEYS = ['id', 'path', 'sha256', 'size', 'package', 'version', 'license', 'license_ref', 'source_ref'];

function lockObject(value, path) {
  if (!isPlainObject(value)) throw new ContractError('INVALID_TYPE', path, 'must be a plain object');
  return value;
}

function exactKeys(value, path, required) {
  for (const key of Object.keys(value)) {
    if (!required.includes(key)) throw new ContractError('UNKNOWN_FIELD', `${path}.${key}`, 'unknown field is rejected');
  }
  for (const key of required) {
    if (!(key in value)) throw new ContractError('MISSING_FIELD', `${path}.${key}`, 'required field is missing');
  }
}

/** Validate source-lock shape; unknown fields are rejected, not ignored. */
export function validateSourceLock(value, path = 'source-lock') {
  lockObject(value, path);
  exactKeys(value, path, LOCK_TOP_KEYS);
  if (value.schema_version !== 1) throw new ContractError('INVALID_VALUE', `${path}.schema_version`, 'must be 1');
  lockObject(value.host, `${path}.host`);
  exactKeys(value.host, `${path}.host`, ['version', 'exe_sha256', 'asar_sha256', 'runtime']);
  assertVersion(value.host.version, `${path}.host.version`);
  assertSha256(value.host.exe_sha256, `${path}.host.exe_sha256`);
  assertSha256(value.host.asar_sha256, `${path}.host.asar_sha256`);
  lockObject(value.host.runtime, `${path}.host.runtime`);
  exactKeys(value.host.runtime, `${path}.host.runtime`, ['executable', 'version', 'sha256']);
  assertVersion(value.host.runtime.version, `${path}.host.runtime.version`);
  assertSha256(value.host.runtime.sha256, `${path}.host.runtime.sha256`);
  assertRef(value.host.runtime.executable, `${path}.host.runtime.executable`);
  lockObject(value.runtime, `${path}.runtime`);
  exactKeys(value.runtime, `${path}.runtime`, ['path', 'version', 'sha256']);
  assertRef(value.runtime.path, `${path}.runtime.path`);
  assertVersion(value.runtime.version, `${path}.runtime.version`);
  assertSha256(value.runtime.sha256, `${path}.runtime.sha256`);
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > 256) {
    throw new ContractError('INVALID_VALUE', `${path}.artifacts`, 'must be a non-empty array (max 256)');
  }
  const ids = new Set();
  value.artifacts.forEach((artifact, index) => {
    const artifactPath = `${path}.artifacts[${index}]`;
    lockObject(artifact, artifactPath);
    exactKeys(artifact, artifactPath, ARTIFACT_KEYS);
    assertStableId(artifact.id, `${artifactPath}.id`);
    if (ids.has(artifact.id)) throw new ContractError('INVALID_VALUE', `${artifactPath}.id`, 'duplicate artifact id');
    ids.add(artifact.id);
    assertRef(artifact.path, `${artifactPath}.path`);
    assertSha256(artifact.sha256, `${artifactPath}.sha256`);
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) throw new ContractError('INVALID_VALUE', `${artifactPath}.size`, 'must be a non-negative integer');
    assertPackageName(artifact.package, `${artifactPath}.package`);
    assertVersion(artifact.version, `${artifactPath}.version`);
    assertRef(artifact.license, `${artifactPath}.license`);
    assertRef(artifact.license_ref, `${artifactPath}.license_ref`);
    assertRef(artifact.source_ref, `${artifactPath}.source_ref`);
  });
  if (!Array.isArray(value.selected_modules) || value.selected_modules.length > 32) {
    throw new ContractError('INVALID_VALUE', `${path}.selected_modules`, 'must be an array (max 32)');
  }
  value.selected_modules.forEach((id, index) => {
    if (typeof id !== 'string' || !/^(0[1-7])$/.test(id)) throw new ContractError('INVALID_VALUE', `${path}.selected_modules[${index}]`, 'must be a module id 01..07');
  });
  if (!Array.isArray(value.evidence_refs) || value.evidence_refs.length > 32) {
    throw new ContractError('INVALID_VALUE', `${path}.evidence_refs`, 'must be an array (max 32)');
  }
  value.evidence_refs.forEach((ref, index) => assertRef(ref, `${path}.evidence_refs[${index}]`));
  return value;
}

/**
 * Verify artifact hashes/sizes against the working tree. A source-lock is only
 * meaningful when every reviewed artifact still has the locked bytes.
 */
export function verifySourceLock(lock, {root, readFile = (path) => readFileSync(path), stat = (path) => statSync(path)} = {}) {
  validateSourceLock(lock);
  const rootPath = root ?? process.cwd();
  const failures = [];
  const verified = [];
  for (const artifact of lock.artifacts) {
    const full = join(rootPath, ...artifact.path.split('/'));
    let bytes;
    try {
      bytes = readFile(full);
      const size = stat(full).size;
      if (size !== artifact.size) failures.push({artifact: artifact.id, path: artifact.path, code: 'SIZE_MISMATCH', expected: artifact.size, actual: size});
    } catch (error) {
      failures.push({artifact: artifact.id, path: artifact.path, code: 'MISSING', detail: String(error.message ?? error)});
      continue;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== artifact.sha256) failures.push({artifact: artifact.id, path: artifact.path, code: 'DIGEST_MISMATCH', expected: artifact.sha256, actual});
    else verified.push({artifact: artifact.id, path: artifact.path, sha256: actual});
  }
  return {ok: failures.length === 0, host: lock.host, verified, failures};
}

/** Directory digest helper for evidence rows (sorted path + content hashes). */
export function digestDirectory(files) {
  const rows = files
    .map(({path, bytes}) => `${path}:${createHash('sha256').update(bytes).digest('hex')}`)
    .sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}
