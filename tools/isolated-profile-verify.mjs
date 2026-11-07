#!/usr/bin/env node
// Full isolated-profile verification (T4 final layer, stage A).
//
// 1. Verify the pinned rc.5 executable/archive/seams and source-lock.
// 2. Build an isolated DSH_HOME + `web` profile that lists @local/dsh-workbench-ui
//    as a bundle (junction into this repository) plus the shipped base/web
//    bundles, and a fixture-only workbench config/scratch profile store.
// 3. Boot `dsh web` from the installed Electron embedded Node on a free port;
//    fetch the real index HTML, parse `__DSH_BOOT__`, prove our client module
//    entry exists and that the web server serves our client bundle bytes.
// 4. Re-boot with a fresh token and drive a real Chromium (installed Electron)
//    through the render probe: sidebar entry, panel, fixture banner, owner
//    release versions, return-to-chat and re-open; capture a screenshot.
// 5. Write evidence/isolated-profile/verification.json (+ render.png).
//
// Only scratch DSH_HOME is used; the user's real profile/credentials are never
// read. This proves fixture-stage render, not real 05/07 capability behavior.
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HOST_BASELINE} from '../src/contracts.mjs';
import {validateSourceLock, verifyHostDigests, verifyHostSeams, verifySourceLock} from '../src/compat.mjs';
import {createProfileStore} from '../src/profile-store.mjs';
import {composeFixture, loadFixtureCatalog} from './compose.mjs';
import {readArchiveHeader, readEntry} from './host-rc5/asar.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTABLE = 'E:/dsh/DeepSeek Harness.exe';
const ARCHIVE = 'E:/dsh/resources/app.asar';
const HOST_ROOT = 'E:/dsh/resources/app.asar/dsh';
const BIN = `${HOST_ROOT}/node_modules/@deepseek-ai/dsh/lib/bin.js`;
const ELECTRON = process.env.DSH_ELECTRON_BIN ?? 'C:/Users/admin/.dsh/electron/electron.exe';
const SCRATCH = join(ROOT, 'scratch', 'isolated-profile');
const EVIDENCE = join(ROOT, 'evidence', 'isolated-profile');
const PROFILE_REF = 'profiles/fixture-workbench';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function jsonRead(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Step 0: pinned-host and source-lock gates before touching anything. */
function verifyGates() {
  const digests = verifyHostDigests({asarPath: ARCHIVE, executablePath: EXECUTABLE});
  assert(digests.ok, `host digest gate failed: ${JSON.stringify(digests.failures)}`);
  const {header, dataOffset} = readArchiveHeader(ARCHIVE);
  const seams = verifyHostSeams({readAsarFile: (path) => readEntry(ARCHIVE, header, dataOffset, path)});
  assert(seams.ok, `host seam gate failed: ${JSON.stringify(seams.failures)}`);
  const lock = JSON.parse(readFileSync(join(ROOT, 'source-lock.json'), 'utf8'));
  validateSourceLock(lock);
  const lockReport = verifySourceLock(lock, {root: ROOT});
  assert(lockReport.ok, `source-lock gate failed: ${JSON.stringify(lockReport.failures)}`);
  return {digests, seams, lock_sha256: sha256File(join(ROOT, 'source-lock.json'))};
}

function wipe(path) {
  const normalized = resolve(path);
  assert(normalized.startsWith(resolve(join(ROOT, 'scratch'))), 'refusing to clean outside the scratch root');
  rmSync(normalized, {recursive: true, force: true});
}

/** Step 1: isolated home, profile and fixture composition. */
async function prepareIsolatedProfile() {
  wipe(SCRATCH);
  const home = join(SCRATCH, 'home');
  const profileDir = join(home, 'profiles', 'web');
  const linkDir = join(profileDir, 'node_modules', '@local');
  mkdirSync(linkDir, {recursive: true});
  symlinkSync(ROOT, join(linkDir, 'dsh-workbench-ui'), 'junction');
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-workbench-ui'];
  writeJson(join(profileDir, 'package.json'), {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {'@local/dsh-workbench-ui': `file:${ROOT}`},
    dsh: {profile: {bundles}},
  });
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n');

  const storeRoot = join(home, 'workbench');
  mkdirSync(storeRoot, {recursive: true});
  const composed = await composeFixture({out: storeRoot, root: ROOT});
  const store = createProfileStore({root: storeRoot, profile_id: 'local-workbench-fixtures'});
  const current = store.loadCurrent();
  const {modules} = loadFixtureCatalog({root: ROOT});
  const config = {
    schema_version: 1,
    fixture_mode: true,
    profile_refs: [PROFILE_REF],
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
        profile_ref: PROFILE_REF,
        profile_revision: current.revision,
        selected_module_ids: modules.map((manifest) => manifest.id),
      },
    }],
    profile_store: {root_ref: 'workbench', profile_id: 'local-workbench-fixtures'},
  };
  const configPath = join(storeRoot, 'workbench.json');
  writeJson(configPath, config);
  return {
    home,
    profileDir,
    configPath,
    bundles,
    profile: {profile_id: 'local-workbench-fixtures', revision: current.revision, composition_digest: current.composition_digest, status: composed.report.status},
    modules: modules.map((manifest) => ({id: manifest.id, name: manifest.name, release_version: manifest.release_version, sha256: manifest.sha256})),
  };
}

function baseEnv(home, configPath) {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_WORKBENCH_CONFIG: configPath,
  };
}

/** Step 2: boot the isolated web profile and wait for its one-time URL. */
async function bootWeb({home, configPath, tag}) {
  const stdoutPath = join(SCRATCH, `${tag}.out.log`);
  const stderrPath = join(SCRATCH, `${tag}.err.log`);
  rmSync(stdoutPath, {force: true});
  rmSync(stderrPath, {force: true});
  const child = spawn(EXECUTABLE, [BIN, 'web', '--no-open', '--port', '0'], {
    cwd: ROOT,
    env: baseEnv(home, configPath),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
    writeFileSync(stdoutPath, stdout);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    writeFileSync(stderrPath, stderr);
  });
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const match = /dsh web: (http:\/\/\S+)/.exec(stdout);
    if (match) return {child, exited, url: match[1], stdoutPath, stderrPath, stderr() { return stderr; }};
    if (child.exitCode !== null) break;
    await sleep(250);
  }
  try {
    child.kill();
  } catch {
    // ignore
  }
  throw new Error(`isolated web boot did not print a URL (stderr: ${stderr.slice(-800)})`);
}

async function stopWeb(boot) {
  if (boot === undefined) return;
  if (boot.child.exitCode === null) {
    spawnSync('taskkill', ['/PID', String(boot.child.pid), '/T', '/F'], {windowsHide: true});
  }
  await Promise.race([boot.exited, sleep(10000)]);
}

/** Step 3: real HTTP fetch of index + boot graph + client bundle. */
async function verifyBootGraph(url) {
  const base = new URL(url);
  let response = await fetch(url, {redirect: 'manual'});
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie().map((value) => value.split(';')[0]) : [];
  if (response.status >= 300 && response.status < 400) {
    response = await fetch(new URL(response.headers.get('location') ?? '/', base), {
      headers: cookies.length === 0 ? {} : {cookie: cookies.join('; ')},
      redirect: 'manual',
    });
  }
  const html = await response.text();
  assert(response.status === 200, `index HTML status ${response.status}`);
  const match = /globalThis\["__DSH_BOOT__"\]\s*=\s*(\{.*?\})\s*;?\s*<\/script>/s.exec(html);
  assert(match !== null, 'boot manifest not found in index HTML');
  const boot = JSON.parse(match[1]);
  assert(boot.release?.version === HOST_BASELINE.version, `boot release ${boot.release?.version} is not ${HOST_BASELINE.version}`);
  const entry = boot.entries.find((row) => row.id === '@local/dsh-workbench-ui');
  assert(entry !== undefined, 'workbench client module is missing from the boot graph');
  const packageManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const expectedInject = packageManifest.dsh.client.inject;
  assert(JSON.stringify(entry.inject) === JSON.stringify(expectedInject), `boot graph inject ${JSON.stringify(entry.inject)} != package dsh.client.inject`);
  const clientUrl = new URL(entry.url.replace(/&amp;/g, '&'), base).href;
  const clientResponse = await fetch(clientUrl, {headers: cookies.length === 0 ? {} : {cookie: cookies.join('; ')}});
  const clientBytes = Buffer.from(await clientResponse.arrayBuffer());
  assert(clientResponse.status === 200, `client bundle status ${clientResponse.status}`);
  const clientText = clientBytes.toString('utf8');
  assert(clientText.includes("'@local/dsh-workbench-ui'") || clientText.includes('"@local/dsh-workbench-ui"'), 'served client bundle has no workbench loader id');
  assert(clientText.includes('window.__ModuleLoader__.load('), 'served client bundle has no loader facade');
  const repoBytes = readFileSync(join(ROOT, 'bundle', 'client.js'));
  // The rc.5 combo server appends a source-map reference to each served bundle;
  // the reviewed bytes must be an exact prefix of the served bytes.
  const prefixMatches = clientBytes.length >= repoBytes.length && clientBytes.subarray(0, repoBytes.length).equals(repoBytes);
  assert(prefixMatches, 'served client bundle bytes differ from the reviewed bundle prefix');
  const servedSuffix = clientBytes.subarray(repoBytes.length).toString('utf8');
  assert(/^;\r?\n\/\/# sourceMappingURL=/.test(servedSuffix), `unexpected combo-server suffix: ${JSON.stringify(servedSuffix.slice(0, 200))}`);
  return {
    index_status: response.status,
    html_bytes: html.length,
    boot_rev: boot.rev,
    release: boot.release,
    plugin_count: boot.entries.length,
    workbench_entry: entry,
    client: {
      url: clientUrl,
      status: clientResponse.status,
      bytes: clientBytes.length,
      sha256: sha256(clientBytes),
      loader_id: true,
      loader_facade: true,
    },
  };
}

/** Step 4: real Chromium render probe. */
async function verifyRender(url) {
  const probeSource = join(ROOT, 'tools', 'isolated-profile');
  const appDir = join(SCRATCH, 'electron-app');
  mkdirSync(appDir, {recursive: true});
  copyFileSync(join(probeSource, 'electron-probe.cjs'), join(appDir, 'electron-probe.cjs'));
  copyFileSync(join(probeSource, 'package.json'), join(appDir, 'package.json'));
  const outPath = join(SCRATCH, 'render.json');
  const shotPath = join(SCRATCH, 'render.png');
  const env = {...process.env, WB_URL: url, WB_OUT: outPath, WB_SHOT: shotPath};
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [appDir, '--no-sandbox', '--disable-gpu', `--user-data-dir=${join(SCRATCH, 'electron-userdata')}`], {
    cwd: ROOT,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { log += chunk.toString('utf8'); });
  const result = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolvePromise(null);
    }, 200000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise(jsonRead(outPath));
    });
  });
  assert(result !== null, `render probe produced no result (log: ${log.slice(-800)})`);
  assert(result.ok === true, `render probe failed: ${JSON.stringify({steps: result.steps, error: result.error, timeout: result.timeout, dom: result.panelDom})}`);
  assert(Array.isArray(result.panelDom?.cards) && result.panelDom.cards.length >= 2, 'render probe found fewer than two capability cards');
  assert(result.panelDom.cards.some((card) => card.includes('0.0.0-fixture')), 'cards do not show the fixture owner release version');
  assert(result.panelDom.fixtureBanner === true, 'fixture banner is missing');
  assert(result.panelDom.hasReturnButton === true, 'return-to-chat button is missing');
  const consoleErrors = (result.consoleLines ?? []).filter((line) => line.level >= 3);
  assert(consoleErrors.length === 0, `renderer console errors: ${JSON.stringify(consoleErrors.slice(0, 3))}`);
  mkdirSync(EVIDENCE, {recursive: true});
  copyFileSync(shotPath, join(EVIDENCE, 'render.png'));
  return {
    ok: result.ok,
    steps: result.steps,
    panel: {
      fixture_banner: result.panelDom.fixtureBanner,
      cards: result.panelDom.cards,
      return_button: result.panelDom.hasReturnButton,
      workbench_titles: result.panelDom.workbenchTitle,
      aria_live_regions: result.panelDom.liveRegion,
      error_summary: result.panelDom.errorSummary ?? [],
      host_onboarding_visible_at_capture: result.finalOverlay?.onboardingVisible === true,
      host_preview_notice_visible_at_capture: result.finalOverlay?.previewVisible === true,
    },
    console_lines: (result.consoleLines ?? []).slice(0, 50),
    screenshot: 'evidence/isolated-profile/render.png',
    probe_log: log.slice(-1000),
  };
}

async function main() {
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    purpose: 'Full isolated rc.5 profile loader + real Chromium render acceptance for the fixture-stage workbench (T4 final layer)',
    host: HOST_BASELINE,
    isolated_home: SCRATCH,
    layers: {},
    checks: {},
    limitations: [
      'Fixture-only stage A: proves loader/composition/RPC/render contracts, not 05/07 real capability behavior.',
      'No OS-wide egress certification was performed; only static scans and the absence of network APIs in reviewed code are recorded by tools/smoke.mjs.',
      'Uses the locally installed generic Electron binary as the Chromium host for rendering; it is a test instrument, not a shipped dependency.',
      'The isolated fresh DSH_HOME may show the product\'s own first-run preview/login onboarding overlay in the screenshot; the workbench DOM assertions are recorded independently of that host overlay.',
    ],
  };
  let webBoot;
  let renderBoot;
  try {
    report.gates = verifyGates();
    report.layers.gates = true;
    const isolated = await prepareIsolatedProfile();
    report.layers.isolated_profile_prepared = true;
    report.profile = isolated.profile;
    report.bundles = isolated.bundles;
    report.workbench_modules = isolated.modules;

    webBoot = await bootWeb({home: isolated.home, configPath: isolated.configPath, tag: 'boot-graph'});
    report.checks.boot_graph = await verifyBootGraph(webBoot.url);
    report.layers.full_profile_loader = true;
    report.checks.boot_graph.stderr = webBoot.stderr().slice(0, 2000);
    await stopWeb(webBoot);
    webBoot = undefined;

    renderBoot = await bootWeb({home: isolated.home, configPath: isolated.configPath, tag: 'render'});
    report.checks.render = await verifyRender(renderBoot.url);
    report.layers.client_browser_render = true;
    report.checks.render.stderr = renderBoot.stderr().slice(0, 2000);
    await stopWeb(renderBoot);
    renderBoot = undefined;

    report.ok = Object.values(report.layers).every((value) => value === true);
    report.verified = report.ok;
    report.exit_code = report.ok ? 0 : 1;
    writeJson(join(EVIDENCE, 'verification.json'), report);
    process.stdout.write(`${JSON.stringify({ok: report.ok, layers: report.layers, boot_graph: {plugins: report.checks.boot_graph.plugin_count, entry: report.checks.boot_graph.workbench_entry.id, client_bytes: report.checks.boot_graph.client.bytes}, render: {steps: report.checks.render.steps, cards: report.checks.render.panel.cards.length, screenshot: report.checks.render.screenshot}}, null, 2)}\n`);
    process.exitCode = report.exit_code;
  } catch (error) {
    report.ok = false;
    report.verified = false;
    report.error = String(error.message ?? error);
    report.layers.failed = false;
    writeJson(join(EVIDENCE, 'verification.json'), report);
    process.stderr.write(`isolated-profile verification failed: ${report.error}\n`);
    process.stdout.write(`${JSON.stringify({ok: false, layers: report.layers, error: report.error}, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await stopWeb(renderBoot);
    await stopWeb(webBoot);
  }
}

main();
