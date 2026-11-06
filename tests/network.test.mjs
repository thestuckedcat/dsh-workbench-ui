// UI-06: no extra egress, no credential reads, bounded responses, sanitized errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHostRuntime, validateWorkbenchConfigV1} from '../src/host-rc5.mjs';
import {
  fixtureConfig,
  fixtureManifest,
  ownerPeer,
  rpcRequest,
} from './helpers/host-fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.mjs') || name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('runtime sources contain no network, process-spawn or dynamic-eval sinks', {skip: !existsSync(join(ROOT, 'bundle', 'client.js'))}, () => {
  const patterns = [
    /\bfetch\s*\(/,
    /node:http/,
    /node:https/,
    /node:net\b/,
    /node:dns/,
    /node:tls/,
    /new\s+WebSocket/,
    /XMLHttpRequest/,
    /child_process/,
    /\bspawn\s*\(/,
    /\bexecFile\s*\(/,
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
  ];
  const offenders = [];
  for (const file of [...sourceFiles(join(ROOT, 'src')), join(ROOT, 'bundle', 'index.js'), join(ROOT, 'bundle', 'client.js')]) {
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, index) => {
      for (const pattern of patterns) {
        if (pattern.test(line) && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*')) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${index + 1}: ${line.trim()}`);
        }
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test('only the reviewed environment variables are read', () => {
  const allowed = new Set(['DSH_WORKBENCH_CONFIG', 'DSH_HOME', 'DSH_AUDIT_APP_ROOT']);
  const used = new Set();
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) used.add(match[1]);
    for (const match of text.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)) used.add(match[1]);
  }
  for (const name of used) assert.ok(allowed.has(name), `unexpected env read ${name}`);
  assert.ok([...used].every((name) => !/TOKEN|SECRET|KEY|PASSWORD|COOKIE|CREDENTIAL/.test(name)));
});

test('network-capable modules and secret-shaped config fields are rejected', () => {
  for (const mode of ['approved_model', 'trusted_targets']) {
    const networkModule = fixtureManifest('05', {network: {mode, target_refs: ['trusted/ref']}});
    assert.throws(() => validateWorkbenchConfigV1(fixtureConfig({modules: [networkModule]})), undefined, mode);
  }
  const config = fixtureConfig();
  config.contexts[0].display.api_token = 'sk-live-secret';
  assert.throws(() => validateWorkbenchConfigV1(config));
  const topLevel = fixtureConfig();
  topLevel.credentials = [{kind: 'api_key', value: 'sk-live-secret'}];
  assert.throws(() => validateWorkbenchConfigV1(topLevel));
});

test('config and responses never echo secret material or absolute machine paths', async () => {
  const config = fixtureConfig();
  const runtime = await createHostRuntime({config});
  const context = config.contexts[0];
  for (const endpoint of [
    ['context.list', null, {}],
    ['status.get', context, {}],
    ['navigation.prepare', context, {module_id: '05'}],
  ]) {
    const [name, ctxRow, input] = endpoint;
    const response = await runtime.handler(name, rpcRequest(ctxRow, input), undefined, ownerPeer());
    const text = JSON.stringify(response);
    assert.ok(!/sk-live|credentials|\.credentials\.yaml|C:\\\\Users|[A-Za-z]:\\\\/i.test(text), `${name} leaked host data`);
  }
  runtime.dispose();
});

test('thrown descriptor errors are sanitized to fixed codes', async () => {
  const config = fixtureConfig({fixtureMode: false});
  const runtime = await createHostRuntime({config});
  runtime.registry.registerDescriptor({
    contract_version: 1,
    id: '05',
    release_version: '0.0.0-fixture.1',
    entry: {kind: 'panel', ref: 'local-memory'},
    async getStatus() {
      throw new Error('C:\\Users\\admin\\.dsh\\.credentials.yaml apiKey=sk-live');
    },
    subscribe() {
      return () => {};
    },
    planOpen() {
      throw new Error('child_process.spawn("curl", ["https://evil.invalid"])');
    },
    quiesce() {
      return Promise.resolve({status: 'idle'});
    },
    dispose() {},
  });
  const context = config.contexts[0];
  const status = await runtime.handler('status.get', rpcRequest(context, {}), undefined, ownerPeer());
  const nav = await runtime.handler('navigation.prepare', rpcRequest(context, {module_id: '05'}), undefined, ownerPeer());
  for (const response of [status, nav]) {
    const text = JSON.stringify(response);
    for (const forbidden of ['credentials', 'apiKey', 'sk-live', 'curl', 'evil.invalid', 'child_process']) assert.ok(!text.includes(forbidden), forbidden);
  }
  runtime.dispose();
});

test('oversized responses fail with a fixed LIMIT_EXCEEDED envelope', async () => {
  const config = fixtureConfig();
  const huge = 'x'.repeat(2 * 1024 * 1024);
  const compose = {
    async preview() {
      return {preview_id: 'p', diff: {added: [], removed: [], changed: [], unchanged: []}, composition_digest: 'f'.repeat(64), expires_at: '2026-11-07T00:10:00.000Z', blob: huge};
    },
  };
  const runtime = await createHostRuntime({config, compose});
  const context = config.contexts[0];
  const response = await runtime.handler('composition.preview', rpcRequest(context, {profile_ref: 'profiles/fixture', expected_revision: 1, selected_ids: ['05']}), undefined, ownerPeer());
  assert.equal(response.status, 'invalid');
  assert.equal(response.reason_code, 'LIMIT_EXCEEDED');
  runtime.dispose();
});

test('the workbench path does not require or perform any fetch when handlers run', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error('network forbidden in workbench tests');
  };
  try {
    const config = fixtureConfig();
    const runtime = await createHostRuntime({config});
    const context = config.contexts[0];
    await runtime.handler('context.list', rpcRequest(null, {}), undefined, ownerPeer());
    await runtime.handler('status.get', rpcRequest(context, {}), undefined, ownerPeer());
    await runtime.handler('navigation.prepare', rpcRequest(context, {module_id: '05'}), undefined, ownerPeer());
    assert.equal(fetchCalls, 0);
    runtime.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('client bundle contains no fetch/CSS-CDN/remote asset references', {skip: !existsSync(join(ROOT, 'bundle', 'client.js'))}, () => {
  const text = readFileSync(join(ROOT, 'bundle', 'client.js'), 'utf8');
  for (const pattern of [/\bfetch\s*\(/, /https?:\/\//, /@import\s+url/, /fonts\.googleapis/, /cdn\./i, /\bimport\s*\(/]) {
    assert.ok(!pattern.test(text), `${pattern} present in client bundle`);
  }
  for (const requiredModule of ['slots', 'layout', 'connection']) assert.ok(text.includes(requiredModule));
});
