#!/usr/bin/env node
// Isolated first-version smoke (T4 / stage A): fixture catalog -> scratch profile
// composition -> local workbench Host runtime over the real RPC handler shapes.
//
// It never installs a bundle, never boots a profile, never reads credentials and
// never touches the network. The output records which layers were actually
// exercised; T5 real 05/07 modules stay blocked until independent releases exist.
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HOST_BASELINE} from '../src/contracts.mjs';
import {validateSourceLock, verifySourceLock} from '../src/compat.mjs';
import {createHostRuntime, loadWorkbenchConfig} from '../src/host-rc5.mjs';
import {createCompositionAdapter} from '../src/composition-adapter.mjs';
import {createProfileStore} from '../src/profile-store.mjs';
import {composeFixture, loadFixtureCatalog} from './compose.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(ROOT, 'scratch', 'smoke');
const EVIDENCE = join(ROOT, 'evidence', 'verification.json');

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseArgs(argv) {
  const options = {isolated: false, fixture: false, modules: null, networkEvidence: false};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--isolated') options.isolated = true;
    else if (arg === '--fixture') options.fixture = true;
    else if (arg === '--modules') options.modules = (argv[++index] ?? '').split(',').filter(Boolean);
    else if (arg === '--network-evidence') options.networkEvidence = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function wipeScratch(path) {
  const normalized = resolve(path);
  if (!normalized.startsWith(resolve(join(ROOT, 'scratch')))) throw new Error('refusing to clean outside the scratch root');
  rmSync(normalized, {recursive: true, force: true});
}

function buildConfig({modules, profileRevision, profileRef}) {
  return {
    schema_version: 1,
    fixture_mode: true,
    profile_refs: [profileRef],
    catalog: {catalog_ref: 'profile/components.json', fixtures: true, modules},
    contexts: [{
      access: {
        context_ref: 'ctx-fixture',
        scope_ref: 'fixture/scope-one',
        scope_generation: 1,
        session_ref: 'fixture/session-one',
        allowed_module_ids: modules.map((manifest) => manifest.id),
        active: true,
      },
      display: {
        label: 'Fixture project (not a real capability)',
        context_revision: 'fixture/ctx-rev-1',
        profile_ref: profileRef,
        profile_revision: profileRevision,
        selected_module_ids: modules.map((manifest) => manifest.id),
      },
    }],
    profile_store: {root_ref: 'workbench', profile_id: 'local-workbench-fixtures'},
  };
}

function request(context, input, operationId, viewEpoch = 1) {
  return {
    schema_version: 1,
    operation_id: operationId,
    context_ref: context?.access?.context_ref ?? 'bootstrap',
    expected_scope_generation: context?.access?.scope_generation ?? 1,
    view_epoch: viewEpoch,
    input,
  };
}

function scanClientBundle() {
  const path = join(ROOT, 'bundle', 'client.js');
  if (!existsSync(path)) return {ok: false, reason: 'bundle/client.js is missing'};
  const text = readFileSync(path, 'utf8');
  const checks = {
    loader_facade: text.includes('window.__ModuleLoader__.load('),
    package_id: text.includes("'@local/dsh-workbench-ui'") || text.includes('"@local/dsh-workbench-ui"'),
    main_key: text.includes('local-workbench'),
    react_only_require: !/require\((['"])(?!react)/.test(text),
    no_fetch: !/\bfetch\s*\(/.test(text),
    no_remote_assets: !/https?:\/\//.test(text),
    no_dynamic_import: !/\bimport\s*\(/.test(text),
  };
  return {ok: Object.values(checks).every(Boolean), checks, bytes: text.length, sha256: createHash('sha256').update(text).digest('hex')};
}

async function runSmoke(options) {
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    mode: options.isolated ? 'isolated' : 'read-only-local',
    fixture: options.fixture === true,
    fixture_mode: true,
    command: `runtime/node.exe tools/smoke.mjs ${process.argv.slice(2).join(' ')}`.trim(),
    host: HOST_BASELINE,
    checks: {},
    limitations: [],
  };

  if (!options.fixture && Array.isArray(options.modules) && options.modules.length > 0) {
    report.checks.real_modules = {
      ok: false,
      status: 'blocked',
      modules: options.modules,
      reason_code: 'NOT_READY',
      detail: '05 is in progress (no full Host/UI release) and 07 has no implemented release; T5 cannot be marked done. Use --fixture for the stage-A framework smoke.',
    };
    report.ok = false;
    report.layers = {static_contracts: true, fixture_compose: false, host_rpc_component: false, real_modules: false};
    writeEvidence(report);
    return {exitCode: 2, report};
  }

  try {
    const lock = JSON.parse(readFileSync(join(ROOT, 'source-lock.json'), 'utf8'));
    validateSourceLock(lock);
    const lockReport = verifySourceLock(lock, {root: ROOT});
    report.checks.source_lock = {ok: lockReport.ok, host: lock.host, failures: lockReport.failures};
  } catch (error) {
    report.checks.source_lock = {ok: false, failures: [{code: 'SOURCE_LOCK_UNREADABLE', detail: String(error.message ?? error)}]};
  }
  report.source_lock_sha256 = sha256File(join(ROOT, 'source-lock.json'));

  let modules = [];
  try {
    const loaded = loadFixtureCatalog({root: ROOT});
    modules = loaded.modules;
    report.checks.fixture_catalog = {ok: true, catalog_id: loaded.catalog.catalog_id, modules: modules.map((manifest) => manifest.id)};
  } catch (error) {
    report.checks.fixture_catalog = {ok: false, detail: String(error.message ?? error)};
    report.ok = false;
    report.layers = {static_contracts: report.checks.source_lock?.ok === true, fixture_catalog: false};
    writeEvidence(report);
    return {exitCode: 1, report};
  }

  wipeScratch(SCRATCH);
  const home = join(SCRATCH, 'home');
  mkdirSync(home, {recursive: true});
  const storeRoot = join(home, 'workbench');
  try {
    const composed = await composeFixture({out: storeRoot, root: ROOT});
    const store = createProfileStore({root: storeRoot, profile_id: 'local-workbench-fixtures'});
    const current = store.loadCurrent();
    report.checks.fixture_compose = {
      ok: composed.exitCode === 0 && ['active', 'restart_required'].includes(composed.report.status),
      status: composed.report.status,
      ordered: composed.report.ordered,
      composition_digest: composed.report.composition_digest,
      revision: current.revision,
      scratch_root: storeRoot,
    };
    report.profile_revision = current.revision;
    report.composition_digest = current.composition_digest;
  } catch (error) {
    report.checks.fixture_compose = {ok: false, detail: String(error.message ?? error)};
  }

  if (report.checks.fixture_compose.ok) {
    const profileRef = 'profiles/fixture-workbench';
    const config = buildConfig({modules, profileRevision: report.profile_revision, profileRef});
    const configPath = join(home, 'workbench', 'workbench.json');
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const previous = process.env.DSH_WORKBENCH_CONFIG;
    process.env.DSH_WORKBENCH_CONFIG = configPath;
    let runtime;
    try {
      const loaded = loadWorkbenchConfig({dshHome: home});
      const adapter = await createCompositionAdapter({config: loaded.config, dshHome: home});
      runtime = await createHostRuntime({config: loaded.config, dshHome: home, compose: adapter, compositionDigest: adapter?.composition_digest});
      const context = config.contexts[0];
      const owner = {id: 'smoke-owner', principal: {kind: 'owner'}};
      const nonOwner = {id: 'smoke-remote', principal: {kind: 'remote'}};
      const responses = {};
      responses.contextList = await runtime.handler('context.list', request(null, {}, 'smoke-op-1'), undefined, owner);
      responses.contextListDenied = await runtime.handler('context.list', request(null, {}, 'smoke-op-2'), undefined, nonOwner);
      responses.status = await runtime.handler('status.get', request(context, {}, 'smoke-op-3'), undefined, owner);
      responses.statusRepeat = await runtime.handler('status.get', request(context, {after_revision: responses.status.data?.revision ?? 0}, 'smoke-op-4'), undefined, owner);
      responses.navigation = await runtime.handler('navigation.prepare', request(context, {module_id: '05'}, 'smoke-op-5'), undefined, owner);
      responses.preview = await runtime.handler('composition.preview', request(context, {profile_ref: profileRef, expected_revision: report.profile_revision, selected_ids: modules.map((manifest) => manifest.id)}, 'smoke-op-6'), undefined, owner);
      const checks = {
        context_list_ok: responses.contextList?.status === 'ok'
          && responses.contextList.data.contexts.length === 1
          && responses.contextList.data.fixture_mode === true
          && Array.isArray(responses.contextList.data.modules)
          && responses.contextList.data.modules.length === 2
          && responses.contextList.data.modules.every((row) => typeof row.release_version === 'string' && typeof row.name === 'string'),
        owner_required: responses.contextListDenied?.status === 'denied' && responses.contextListDenied.reason_code === 'OWNER_REQUIRED',
        status_ok: responses.status?.status === 'ok' && responses.status.data.modules.length === 2 && responses.status.data.modules.every((module) => module.state === 'ready'),
        after_revision_no_body: responses.statusRepeat?.data?.changed === false && Array.isArray(responses.statusRepeat.data.modules) && responses.statusRepeat.data.modules.length === 0,
        navigation_accepted: responses.navigation?.status === 'ok' && responses.navigation.data.status === 'accepted' && responses.navigation.data.navigation_intent?.target?.kind === 'panel',
        composition_preview_ok: responses.preview?.status === 'ok' && typeof responses.preview.data.preview_id === 'string',
        no_secret_echo: ![responses.contextList, responses.status, responses.navigation, responses.preview].some((response) => /credentials|api[_-]?key|secret|C:\\\\/i.test(JSON.stringify(response))),
      };
      report.checks.host_rpc_component = {ok: Object.values(checks).every(Boolean), checks, responses: summarizeResponses(responses)};
      report.module_digests = Object.fromEntries(modules.map((manifest) => [manifest.id, manifest.sha256]));
      report.fixture_modules = modules.map((manifest) => ({id: manifest.id, name: manifest.name, release_version: manifest.release_version}));
      runtime.dispose();
    } catch (error) {
      report.checks.host_rpc_component = {ok: false, detail: String(error.message ?? error)};
      try {
        runtime?.dispose();
      } catch {
        // keep the first failure
      }
    } finally {
      if (previous === undefined) delete process.env.DSH_WORKBENCH_CONFIG;
      else process.env.DSH_WORKBENCH_CONFIG = previous;
    }
  }

  report.checks.client_bundle_static = scanClientBundle();

  if (options.networkEvidence) {
    const files = ['bundle/index.js', 'bundle/client.js', 'src/host-rc5.mjs', 'src/rpc.mjs', 'src/access.mjs', 'src/registry.mjs', 'src/actions.mjs', 'src/events.mjs'];
    const scan = [];
    for (const file of files) {
      const path = join(ROOT, ...file.split('/'));
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      const hits = [];
      for (const pattern of [/\bfetch\s*\(/, /node:https?/, /node:net\b/, /child_process/, /new\s+WebSocket/, /XMLHttpRequest/, /https?:\/\/[^'"\s]+/]) {
        if (pattern.test(text)) hits.push(String(pattern));
      }
      scan.push({path: file, sha256: sha256File(path), forbidden_hits: hits});
    }
    report.checks.network_static = {ok: scan.every((row) => row.forbidden_hits.length === 0), files: scan};
  }

  const isolated = readJsonIfExists(join(ROOT, 'evidence', 'isolated-profile', 'verification.json'));
  report.checks.isolated_profile = {
    ok: isolated?.verified === true,
    layers: isolated?.layers ?? null,
    error: isolated?.error ?? null,
  };
  const layers = {
    static_contracts: report.checks.source_lock?.ok === true,
    fixture_catalog: report.checks.fixture_catalog?.ok === true,
    fixture_compose: report.checks.fixture_compose?.ok === true,
    host_rpc_component: report.checks.host_rpc_component?.ok === true,
    client_bundle_static: report.checks.client_bundle_static?.ok === true,
    real_pinned_cordis_host: readJsonIfExists(join(ROOT, 'evidence', 'host-rc5', 'host24.json'))?.verified === true,
    isolated_profile: isolated?.verified === true,
    full_profile_loader: isolated?.layers?.full_profile_loader === true,
    client_browser_render: isolated?.layers?.client_browser_render === true,
    real_modules_05_07: false,
    os_egress_certification: false,
  };
  report.layers = layers;
  report.blocked = {
    T5_real_05_07: {
      status: 'blocked',
      reason_code: 'NOT_READY',
      detail: '05 is in progress without a full-Host/UI release; 07 has no implemented release. Fixture success must not be reported as real capability availability.',
    },
    T6_followup_modules: {status: 'blocked', reason_code: 'NOT_READY', detail: 'No verified releases for 06/03/04/02/01; interfaces and the compatibility matrix are prepared only.'},
    os_egress_certification: {status: 'pending', reason_code: 'NEEDS_VERIFICATION', detail: 'Only static source scans are recorded; no OS-wide egress certification has been performed.'},
  };
  report.limitations = [
    'Fixture modules are synthetic descriptors: composition success proves solver/transaction/RPC/render contracts, not 05/07 capability behavior.',
    'The full profile loader and browser render layer is recorded separately in evidence/isolated-profile/verification.json (fixture stage only).',
    'Real Cordis mount evidence exists separately (evidence/host-rc5/host24.json) and uses a local Host-services double.',
    'No OS-wide egress certification; only static source scans and the absence of network APIs in reviewed code are recorded.',
  ];
  const required = ['source_lock', 'fixture_catalog', 'fixture_compose', 'host_rpc_component', 'client_bundle_static', 'isolated_profile'];
  report.ok = required.every((key) => report.checks[key]?.ok === true);
  report.exit_code = report.ok ? 0 : 1;
  writeEvidence(report);
  return {exitCode: report.exit_code, report};
}

function summarizeResponses(responses) {
  const summary = {};
  for (const [key, response] of Object.entries(responses)) {
    summary[key] = response === undefined ? null : {status: response.status, reason_code: response.reason_code ?? null};
  }
  return summary;
}

function readJsonIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeEvidence(report) {
  mkdirSync(dirname(EVIDENCE), {recursive: true});
  writeFileSync(EVIDENCE, `${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ok: false, error: String(error.message)}, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  const {exitCode, report} = await runSmoke(options);
  process.stdout.write(`${JSON.stringify({ok: report.ok, exit_code: exitCode, layers: report.layers, checks: Object.fromEntries(Object.entries(report.checks).map(([key, value]) => [key, value.ok]))}, null, 2)}\n`);
  process.exitCode = exitCode;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
export {runSmoke};