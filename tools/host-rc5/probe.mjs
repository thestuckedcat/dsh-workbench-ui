#!/usr/bin/env node
// Produce/refresh evidence/host-rc5/source-manifest.json: the read-only archive
// facts the workbench adapter is bound to (T1 / UI-01).
//
// Read-only: parses the installed app.asar and hashes selected files; never
// executes archive content and never writes outside this repository.
import {writeFileSync, statSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HOST_BASELINE} from '../../src/contracts.mjs';
import {HOST_FACTS_V1, verifyHostDigests, verifyHostSeams} from '../../src/compat.mjs';
import {readArchiveHeader, readEntry, listEntries} from './asar.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARCHIVE = 'E:/dsh/resources/app.asar';
const EXECUTABLE = 'E:/dsh/DeepSeek Harness.exe';

function main() {
  const digests = verifyHostDigests({asarPath: ARCHIVE, executablePath: EXECUTABLE});
  const {header, dataOffset, headerSize} = readArchiveHeader(ARCHIVE);
  const readAsarFile = (path) => readEntry(ARCHIVE, header, dataOffset, path);
  const seams = verifyHostSeams({readAsarFile});

  // Static module seeds the client shell provides to plugin bundles. Reviewed
  // in the pinned web frontend asset; recorded here as a fact, not re-parsed.
  const staticModuleRow = HOST_FACTS_V1.files.find((row) => row.path.endsWith('dsh-web-frontend/dist/assets/index-BXV-oxvX.js'));
  const facts = {
    static_modules: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
      'zod',
      '@tanstack/react-virtual',
      '@deepseek-ai/dsh-client-store',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-dockkit',
    ],
    static_modules_source: staticModuleRow === undefined ? null : {path: staticModuleRow.path, sha256: staticModuleRow.sha256},
    client_bundle_format: 'window.__ModuleLoader__.load({id, factory: (require) => ({name, inject, apply})})',
    host_rpc: 'ctx.connection.rpc.handle(channel, async (endpoint, payload, signal, peer) => value)',
    client_rpc: 'ctx.connection.rpc.call(channel, endpoint, payload, signal) -> {ok:true,value}|{ok:false,error}',
    navigation: 'ctx.layout.selectPanel(panel_key|null); main slot kind=keyed scope=root; panellist entry id === main key',
  };

  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    purpose: 'Pinned rc.5 archive/source seams for the local workbench adapter; read-only evidence, no runtime acceptance',
    host: HOST_BASELINE,
    archive: {path: ARCHIVE, size: statSync(ARCHIVE).size, header_size: headerSize, entry_count: listEntries(header, {max: 200000}).length},
    executable: {path: EXECUTABLE, size: statSync(EXECUTABLE).size, sha256: digests.executable?.sha256 ?? null},
    digests,
    files: seams.files,
    facts,
    failures: seams.failures,
    limitations: [
      'Read-only archive parse; no extraction to the Harness profile and no execution of archive code.',
      'Source probes assert reviewed text facts; they do not prove a live panel renders.',
      'Full client boot and Host profile loader are recorded by the T4 smoke, not by this file.',
    ],
  };

  mkdirSync(resolve(ROOT, 'evidence/host-rc5'), {recursive: true});
  writeFileSync(resolve(ROOT, 'evidence/host-rc5/source-manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ok: seams.ok && digests.ok, files: seams.files.length, failures: [...digests.failures, ...seams.failures]}, null, 2)}\n`);
  process.exitCode = seams.ok && digests.ok ? 0 : 1;
}

main();
