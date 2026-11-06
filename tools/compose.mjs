#!/usr/bin/env node
// Fixture composition CLI (T2/T3 acceptance): resolve -> prepare -> apply.
//
// Scratch output only. The tool refuses a catalog that is not explicitly marked
// `fixtures: true`, refuses to mix real modules into a fixture run, derives the
// Host identity from the reviewed source-lock, and verifies the sealed revision
// locally before reporting `active`. No network, no installer, no real profile.
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HOST_BASELINE, validateModuleManifest, validateProfileV1} from '../src/contracts.mjs';
import {validateSourceLock} from '../src/compat.mjs';
import {compositionDigest} from '../src/resolve.mjs';
import {createProfileStore} from '../src/profile-store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const FIXTURE_PROFILE_ID = 'local-workbench-fixtures';
export const FIXTURE_CATALOG_REL = 'profile/components.json';
export const SOURCE_LOCK_REL = 'source-lock.json';

function diagnostic(code, severity, messageKey) {
  return {code, severity, module_ids: [], resource_ref: null, message_key: messageKey};
}

function emptyReport(diagnostics) {
  return {
    status: 'blocked',
    enabled: [],
    ordered: [],
    composition_digest: null,
    revision: null,
    preview_id: null,
    diagnostics,
  };
}

/** Read and strictly validate the local fixture catalog. */
export function loadFixtureCatalog({root = ROOT} = {}) {
  const catalogPath = join(root, FIXTURE_CATALOG_REL);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch {
    throw new Error('fixture catalog is unreadable');
  }
  if (parsed.schema_version !== 1) throw new Error('fixture catalog schema_version must be 1');
  if (parsed.catalog_id !== FIXTURE_PROFILE_ID) throw new Error('fixture catalog_id mismatch');
  if (parsed.fixtures !== true) throw new Error('--fixture refuses a catalog that is not explicitly fixtures:true');
  if (!Array.isArray(parsed.real_modules) || parsed.real_modules.length > 0) {
    throw new Error('--fixture refuses a catalog that mixes real modules');
  }
  if (!Array.isArray(parsed.modules) || parsed.modules.length === 0) throw new Error('fixture catalog has no modules');
  const modules = parsed.modules.map((manifest, index) => validateModuleManifest(manifest, `catalog.modules[${index}]`));
  return {catalog: parsed, modules};
}

/** Host identity comes from the reviewed source-lock, not from a guess. */
export function pinnedHostIdentity({root = ROOT} = {}) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(join(root, SOURCE_LOCK_REL), 'utf8'));
  } catch {
    throw new Error('source-lock.json is unreadable');
  }
  validateSourceLock(lock);
  if (lock.host.version !== HOST_BASELINE.version) {
    throw new Error(`source-lock host ${lock.host.version} is not the pinned baseline ${HOST_BASELINE.version}`);
  }
  return {
    version: lock.host.version,
    app_asar_sha256: lock.host.asar_sha256,
    executable_sha256: lock.host.exe_sha256,
  };
}

/**
 * Explicit local verification for the sealed revision: re-read both files,
 * re-validate ProfileV1, recompute the composition digest from the module refs,
 * and confirm the current pointer names exactly this revision. This proves the
 * local transaction only; it does not claim the Host loaded the composition.
 */
export function localVerification({store, revision, profile}) {
  try {
    const directory = store.revisionDir(revision);
    const profileRaw = readFileSync(join(directory, 'profile.json'), 'utf8');
    const patchText = readFileSync(join(directory, 'cordis.patch.yml'), 'utf8');
    const stored = validateProfileV1(JSON.parse(profileRaw), 'revision.profile');
    if (stored.revision !== revision) return {status: 'failed', reason_code: 'REVISION_CONFLICT'};
    const recomputed = compositionDigest(stored.host_version, stored.module_refs);
    if (recomputed !== stored.composition_digest || stored.composition_digest !== profile.composition_digest) {
      return {status: 'failed', reason_code: 'DIGEST_MISMATCH'};
    }
    const current = store.loadCurrent();
    if (current.revision !== revision || current.composition_digest !== stored.composition_digest) {
      return {status: 'failed', reason_code: 'REVISION_CONFLICT'};
    }
    if (!patchText.includes(`revision: ${revision}`)) return {status: 'failed', reason_code: 'JOURNAL_CORRUPT'};
    return {
      status: 'active',
      diagnostics: [diagnostic('LOCAL_VERIFICATION', 'info', 'compose.local_verification_only')],
    };
  } catch {
    return {status: 'failed', reason_code: 'INTERNAL_FAILURE'};
  }
}

export function parseComposeArgs(argv) {
  const options = {fixture: false, out: null, selected: null, operationId: null, root: ROOT};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') options.fixture = true;
    else if (arg === '--out') options.out = argv[++index];
    else if (arg === '--selected') options.selected = argv[++index];
    else if (arg === '--operation-id') options.operationId = argv[++index];
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.fixture) throw new Error('only --fixture composition is implemented in T3; pass --fixture');
  if (typeof options.out !== 'string' || options.out.trim() === '') throw new Error('--out <scratch-dir> is required');
  return options;
}

/** Run one fixture composition against an explicit scratch directory. */
export async function composeFixture({out, selected = null, operationId = null, root = ROOT} = {}) {
  try {
    const {modules} = loadFixtureCatalog({root});
    const host = pinnedHostIdentity({root});
    const scratchRoot = resolve(out);
    const catalogIds = modules.map((manifest) => manifest.id);
    let selectedIds = catalogIds;
    if (Array.isArray(selected) && selected.length > 0) selectedIds = selected;
    else if (typeof selected === 'string' && selected.trim() !== '') selectedIds = selected.split(',').map((id) => id.trim());
    for (const id of selectedIds) {
      if (!catalogIds.includes(id)) throw new Error(`selected module ${id} is not in the fixture catalog`);
    }
    const store = createProfileStore({root: scratchRoot, profile_id: FIXTURE_PROFILE_ID});
    const current = store.loadCurrent();
    const policy = {
      network_mode: 'none',
      allowed_target_refs: [],
      allowed_module_ids: catalogIds,
    };
    const prepared = store.prepare({
      selected_ids: selectedIds,
      expected_revision: current.revision,
      catalog: modules,
      host,
      policy,
    });
    if (prepared.status !== 'prepared') {
      return {
        exitCode: 1,
        report: {
          ...emptyReport(prepared.diagnostics ?? []),
          composition_digest: prepared.composition_digest ?? null,
          revision: prepared.revision ?? current.revision,
        },
      };
    }
    const operationIdGenerated = operationId ?? `op-fixture-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const result = await store.apply({
      preview_id: prepared.preview_id,
      expected_revision: current.revision,
      operation_id: operationIdGenerated,
    }, {
      verify: ({revision, profile}) => localVerification({store, revision, profile}),
    });
    const succeeded = result.status === 'active' || result.status === 'restart_required';
    return {
      exitCode: succeeded ? 0 : 1,
      report: {
        status: result.status,
        enabled: prepared.enabled,
        ordered: prepared.ordered,
        composition_digest: result.composition_digest,
        revision: result.revision,
        preview_id: prepared.preview_id,
        diagnostics: result.diagnostics,
      },
    };
  } catch (error) {
    return {
      exitCode: 2,
      report: emptyReport([diagnostic('INVALID_REQUEST', 'error', `compose.fixture_input_invalid`) ]),
    };
  }
}

function isMainModule() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  const self = fileURLToPath(import.meta.url);
  const left = resolve(entry);
  const right = resolve(self);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function main() {
  let options;
  try {
    options = parseComposeArgs(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({...emptyReport([diagnostic('INVALID_REQUEST', 'error', 'compose.invalid_arguments')]), message: String(error.message)}, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  const {exitCode, report} = await composeFixture({out: options.out, selected: options.selected, operationId: options.operationId, root: options.root});
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = exitCode;
}

if (isMainModule()) await main();
