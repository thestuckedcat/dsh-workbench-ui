// T3 / UI-03: scratch profile transaction tests.
//
// Positive: prepare -> apply -> active, idempotent replay, no-op.
// Negative: untrusted paths, stale revision/preview, busy lock, crash after
// switch, external modification, ENOSPC on the pointer switch, quiesce busy,
// and the honest `restart_required` default. Every failure path must keep the
// previous current pointer intact and never touch a real DSH profile.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HOST_BASELINE, validateProfileV1} from '../src/contracts.mjs';
import {createProfileStore, PROFILE_MARKER} from '../src/profile-store.mjs';
import {composeFixture, FIXTURE_PROFILE_ID} from '../tools/compose.mjs';
import {restoreScratch} from '../tools/restore.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_FILE = JSON.parse(nodeFs.readFileSync(join(ROOT, 'profile', 'components.json'), 'utf8'));
const CATALOG = CATALOG_FILE.modules;
const SCRATCH = join(ROOT, 'scratch');
nodeFs.mkdirSync(SCRATCH, {recursive: true});

const HOST = {
  version: HOST_BASELINE.version,
  app_asar_sha256: HOST_BASELINE.app_asar_sha256,
  executable_sha256: HOST_BASELINE.executable_sha256,
};
const POLICY = {network_mode: 'none', allowed_target_refs: [], allowed_module_ids: ['05', '07']};
const sha = (text) => createHash('sha256').update(text).digest('hex');
const verifyActive = () => ({status: 'active'});

function tempRoot(t, label = 'wb') {
  const directory = nodeFs.mkdtempSync(join(SCRATCH, `${label}-`));
  t.after(() => nodeFs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}

function makeStore(t, options = {}) {
  const root = options.root ?? tempRoot(t, 'store');
  const store = createProfileStore({root, profile_id: FIXTURE_PROFILE_ID, ...options});
  return {root, store};
}

function prepare(store, {selected = ['05', '07'], expectedRevision, catalog = CATALOG, host = HOST, policy = POLICY} = {}) {
  const current = store.loadCurrent();
  return store.prepare({
    selected_ids: selected,
    expected_revision: expectedRevision ?? current.revision,
    catalog,
    host,
    policy,
  });
}

async function applyOnce(store, {selected = ['05', '07'], verify = verifyActive, quiesce, crashAfter, op = 'op-1'} = {}) {
  const current = store.loadCurrent();
  const prepared = prepare(store, {selected, expectedRevision: current.revision});
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared.diagnostics));
  return store.apply({
    preview_id: prepared.preview_id,
    expected_revision: current.revision,
    operation_id: op,
  }, {
    verify: verify === null ? undefined : verify,
    quiesce,
    crashAfter,
  });
}

function journalFor(store, operationId) {
  return store.readJournal().find((entry) => entry.operation_id === operationId);
}

// ---------------------------------------------------------------------------
// Trusted-path gate
// ---------------------------------------------------------------------------

test('refuses relative, parent-traversal, UNC and non-empty untracked roots', async (t) => {
  const base = tempRoot(t, 'paths');
  const nonEmpty = join(base, 'not-a-scratch-root');
  nodeFs.mkdirSync(nonEmpty);
  nodeFs.writeFileSync(join(nonEmpty, 'keep.txt'), 'user data');
  const untrusted = [
    'relative/workbench-root',
    `${base}\\..\\escaped-root`, // raw parent segment must be refused before normalization
    '\\\\server\\share\\workbench',
    nonEmpty,
    ROOT,
  ];
  for (const root of untrusted) {
    assert.throws(
      () => createProfileStore({root, profile_id: FIXTURE_PROFILE_ID}),
      (error) => error?.code === 'PATH_UNTRUSTED',
      `root must be refused: ${root}`,
    );
  }
});

test('refuses a symlinked or reparse-point root component', async (t) => {
  const target = tempRoot(t, 'link-target');
  const parent = tempRoot(t, 'link-parent');
  const link = join(parent, 'junction');
  try {
    nodeFs.symlinkSync(target, link, 'junction');
  } catch {
    t.skip('junction creation is not permitted on this machine');
    return;
  }
  assert.throws(
    () => createProfileStore({root: link, profile_id: FIXTURE_PROFILE_ID}),
    (error) => error?.code === 'PATH_UNTRUSTED',
  );
});

test('creates a marker-owned scratch store with an empty revision 0 and reuses it', async (t) => {
  const root = tempRoot(t, 'init');
  const store = createProfileStore({root, profile_id: FIXTURE_PROFILE_ID});
  const marker = JSON.parse(nodeFs.readFileSync(join(root, PROFILE_MARKER), 'utf8'));
  assert.equal(marker.kind, 'workbench-scratch-profile');
  assert.equal(marker.schema_version, 1);
  const current = store.loadCurrent();
  assert.equal(current.revision, 0);
  assert.equal(current.verified, true);
  assert.deepEqual(store.listRevisions(), []);

  const reopened = createProfileStore({root, profile_id: FIXTURE_PROFILE_ID});
  assert.equal(reopened.store_created, false);
  assert.equal(reopened.loadCurrent().revision, 0);
});

// ---------------------------------------------------------------------------
// Happy path / no-op
// ---------------------------------------------------------------------------

test('apply with injected verification activates and seals the revision', async (t) => {
  const {root, store} = makeStore(t, {label: 'active'});
  const result = await applyOnce(store);
  assert.equal(result.status, 'active');
  assert.equal(result.revision, 1);
  assert.equal(result.previous_revision, 0);
  assert.equal(result.composition_digest.length, 64);

  const current = store.loadCurrent();
  assert.equal(current.revision, 1);
  assert.equal(current.status, 'active');
  assert.equal(current.verified, true);
  assert.equal(current.composition_digest, result.composition_digest);
  assert.equal(current.operation_id, 'op-1');

  const revisions = store.listRevisions();
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].revision, 1);
  assert.deepEqual(revisions[0].module_ids, ['05', '07']);

  const revisionDir = store.revisionDir(1);
  const profile = validateProfileV1(JSON.parse(nodeFs.readFileSync(join(revisionDir, 'profile.json'), 'utf8')));
  assert.equal(profile.profile_id, FIXTURE_PROFILE_ID);
  assert.deepEqual(profile.module_refs.map((ref) => ref.id), ['05', '07']);
  assert.equal(profile.composition_digest, result.composition_digest);
  const patchText = nodeFs.readFileSync(join(revisionDir, 'cordis.patch.yml'), 'utf8');
  assert.match(patchText, /SCRATCH FIXTURE COMPOSITION/);
  assert.match(patchText, /revision: 1/);
  assert.match(patchText, /id: "05"/);

  const journal = journalFor(store, 'op-1');
  assert.equal(journal.phase, 'active');
  assert.equal(journal.revision, 1);
  assert.equal(journal.previous_revision, 0);
  // previous_current is the saved pointer snapshot, not a ProfileV1 document.
  assert.equal(journal.previous_current.revision, 0);
  assert.equal(journal.previous_current.status, 'active');

  void root;
});

test('repeated identical composition is a no-op with no second revision', async (t) => {
  const {store} = makeStore(t, {label: 'noop'});
  const first = await applyOnce(store, {op: 'op-first'});
  assert.equal(first.status, 'active');
  const second = await applyOnce(store, {op: 'op-second'});
  assert.equal(second.status, 'active');
  assert.equal(second.no_op, true);
  assert.equal(second.revision, 1);
  assert.equal(store.loadCurrent().revision, 1);
  assert.equal(store.listRevisions().length, 1);
  assert.equal(journalFor(store, 'op-second').phase, 'no_change');
  assert.ok(second.diagnostics.some((diagnostic) => diagnostic.code === 'NO_CHANGE' && diagnostic.severity === 'info'));
});

test('replaying one operation id returns the known result without a new revision', async (t) => {
  const {store} = makeStore(t, {label: 'replay'});
  const current = store.loadCurrent();
  const prepared = prepare(store, {expectedRevision: current.revision});
  assert.equal(prepared.status, 'prepared');
  const first = await store.apply({
    preview_id: prepared.preview_id,
    expected_revision: 0,
    operation_id: 'op-replay',
  }, {verify: verifyActive});
  assert.equal(first.status, 'active');
  const replay = await store.apply({
    preview_id: prepared.preview_id,
    expected_revision: 0,
    operation_id: 'op-replay',
  }, {verify: verifyActive});
  assert.equal(replay.status, 'active');
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.revision, 1);
  assert.equal(store.listRevisions().length, 1);
});

// ---------------------------------------------------------------------------
// Preview / revision guards
// ---------------------------------------------------------------------------

test('prepare rejects a stale expected revision', async (t) => {
  const {store} = makeStore(t, {label: 'stale-rev'});
  await applyOnce(store);
  const stale = prepare(store, {expectedRevision: 0});
  assert.equal(stale.status, 'stale');
  assert.ok(stale.diagnostics.some((diagnostic) => diagnostic.code === 'STALE_REVISION'));
  assert.equal(store.loadCurrent().revision, 1);
});

test('an expired preview is stale and writes nothing', async (t) => {
  let clock = Date.parse('2026-11-07T00:00:00.000Z');
  const {store} = makeStore(t, {label: 'ttl', now: () => clock});
  const prepared = prepare(store, {expectedRevision: 0});
  assert.equal(prepared.status, 'prepared');
  clock += 11 * 60 * 1000; // preview TTL is ten minutes
  const result = await store.apply({
    preview_id: prepared.preview_id,
    expected_revision: 0,
    operation_id: 'op-late',
  }, {verify: verifyActive});
  assert.equal(result.status, 'stale');
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'STALE_PREVIEW'));
  assert.equal(store.listRevisions().length, 0);
  assert.equal(store.loadCurrent().revision, 0);
  assert.equal(journalFor(store, 'op-late'), undefined);
});

test('an external revision change is a revision conflict that preserves both sides', async (t) => {
  const {store} = makeStore(t, {label: 'external-rev'});
  await applyOnce(store);
  const prepared = prepare(store, {selected: ['05'], expectedRevision: 1});
  assert.equal(prepared.status, 'prepared');
  const externalCurrent = {
    schema_version: 1,
    profile_id: FIXTURE_PROFILE_ID,
    revision: 2,
    composition_digest: sha('externally-written-composition'),
    policy_digest: null,
    status: 'active',
    verified: true,
    operation_id: null,
    updated_at: new Date().toISOString(),
    verified_at: null,
  };
  nodeFs.writeFileSync(store.paths.current, `${JSON.stringify(externalCurrent, null, 2)}\n`);
  const externalBytes = nodeFs.readFileSync(store.paths.current, 'utf8');

  const result = await store.apply({
    preview_id: prepared.preview_id,
    expected_revision: 1,
    operation_id: 'op-external',
  }, {verify: verifyActive});
  assert.equal(result.status, 'denied');
  assert.equal(result.reason_code, 'REVISION_CONFLICT');
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'REVISION_CONFLICT'));
  assert.ok(result.diff);
  assert.equal(nodeFs.readFileSync(store.paths.current, 'utf8'), externalBytes);
  assert.equal(store.listRevisions().length, 1);
  assert.equal(journalFor(store, 'op-external'), undefined);
});

test('an external digest change at the same revision is a revision conflict', async (t) => {
  const {store} = makeStore(t, {label: 'external-digest'});
  await applyOnce(store);
  const prepared = prepare(store, {selected: ['05'], expectedRevision: 1});
  const tampered = {...store.loadCurrent(), composition_digest: sha('tampered-digest'), updated_at: new Date().toISOString()};
  nodeFs.writeFileSync(store.paths.current, `${JSON.stringify(tampered, null, 2)}\n`);
  const result = await store.apply({
    preview_id: prepared.preview_id,
    expected_revision: 1,
    operation_id: 'op-tampered',
  }, {verify: verifyActive});
  assert.equal(result.status, 'denied');
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'REVISION_CONFLICT'));
  assert.equal(store.loadCurrent().composition_digest, tampered.composition_digest);
});

test('the same operation id with a different digest is an idempotency conflict', async (t) => {
  const {store} = makeStore(t, {label: 'idem'});
  await applyOnce(store, {op: 'op-fixed'});
  const prepared = prepare(store, {selected: ['05'], expectedRevision: 1});
  assert.equal(prepared.status, 'prepared');
  const result = await store.apply({
    preview_id: prepared.preview_id,
    expected_revision: 1,
    operation_id: 'op-fixed',
  }, {verify: verifyActive});
  assert.equal(result.status, 'denied');
  assert.equal(result.reason_code, 'IDEMPOTENCY_CONFLICT');
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'IDEMPOTENCY_CONFLICT'));
  assert.equal(store.loadCurrent().revision, 1);
  assert.equal(store.listRevisions().length, 1);
});

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

test('a lock owned by a live process is denied and never stolen', async (t) => {
  const {store} = makeStore(t, {label: 'lock-live'});
  const liveLock = {
    schema_version: 1,
    pid: process.pid,
    process_start_token: 'test-live-owner',
    operation: 'op-other',
    created_at: new Date().toISOString(),
  };
  nodeFs.writeFileSync(store.paths.lock, `${JSON.stringify(liveLock, null, 2)}\n`);
  const prepared = prepare(store, {expectedRevision: 0});
  const denied = await store.apply({
    preview_id: prepared.preview_id,
    expected_revision: 0,
    operation_id: 'op-live-lock',
  }, {verify: verifyActive});
  assert.equal(denied.status, 'denied');
  assert.ok(denied.diagnostics.some((diagnostic) => diagnostic.code === 'LOCKED'));
  assert.equal(JSON.parse(nodeFs.readFileSync(store.paths.lock, 'utf8')).process_start_token, 'test-live-owner');
  assert.equal(store.loadCurrent().revision, 0);

  nodeFs.rmSync(store.paths.lock);
  const accepted = await store.apply({
    preview_id: prepared.preview_id,
    expected_revision: 0,
    operation_id: 'op-live-lock',
  }, {verify: verifyActive});
  assert.equal(accepted.status, 'active');
  assert.equal(nodeFs.existsSync(store.paths.lock), false);
});

test('a lock whose owner process exited is cleaned before writing', async (t) => {
  const {store} = makeStore(t, {label: 'lock-stale'});
  // A short-lived child gives us a pid that is provably no longer running.
  const child = spawnSync(process.execPath, ['-e', '0'], {stdio: 'ignore'});
  const deadPid = Number.isInteger(child.pid) && child.pid > 0 ? child.pid : 4_194_304;
  nodeFs.writeFileSync(store.paths.lock, `${JSON.stringify({
    schema_version: 1,
    pid: deadPid,
    process_start_token: 'stale-owner',
    operation: 'op-crashed',
    created_at: new Date(Date.now() - 60_000).toISOString(),
  }, null, 2)}\n`);
  const prepared = prepare(store, {expectedRevision: 0});
  const result = await store.apply({
    preview_id: prepared.preview_id,
    expected_revision: 0,
    operation_id: 'op-after-stale',
  }, {verify: verifyActive});
  assert.equal(result.status, 'active');
  assert.equal(nodeFs.existsSync(store.paths.lock), false);
});

// ---------------------------------------------------------------------------
// Crash / recovery
// ---------------------------------------------------------------------------

test('crash after the switch leaves a journal and recover restores the previous revision', async (t) => {
  const {store} = makeStore(t, {label: 'crash-switch'});
  await applyOnce(store, {op: 'op-stable'});
  const stable = store.loadCurrent();
  const prepared = prepare(store, {selected: ['05'], expectedRevision: 1});

  await assert.rejects(
    () => store.apply({
      preview_id: prepared.preview_id,
      expected_revision: 1,
      operation_id: 'op-crash',
    }, {verify: verifyActive, crashAfter: 'switched'}),
    (error) => error?.simulated_crash === true,
  );

  const crashed = store.loadCurrent();
  assert.equal(crashed.revision, 2);
  assert.equal(crashed.status, 'switching');
  assert.equal(journalFor(store, 'op-crash').phase, 'switched');

  const recovery = store.recover();
  assert.equal(recovery.status, 'rolled_back');
  assert.equal(recovery.revision, 1);
  assert.equal(recovery.recovered, true);
  assert.equal(store.loadCurrent().revision, 1);
  assert.equal(store.loadCurrent().composition_digest, stable.composition_digest);
  assert.equal(store.loadCurrent().status, 'active');
  // Both revisions are preserved for audit; only the pointer moved back.
  assert.deepEqual(store.listRevisions().map((revision) => revision.revision), [1, 2]);
  assert.equal(journalFor(store, 'op-crash').phase, 'rolled_back');

  const idle = store.recover();
  assert.equal(idle.recovered, false);
  assert.equal(idle.status, 'active');
});

test('crash before the switch cleans the unreferenced revision', async (t) => {
  const {store} = makeStore(t, {label: 'crash-staged'});
  await applyOnce(store, {op: 'op-stable'});
  const prepared = prepare(store, {selected: ['05'], expectedRevision: 1});
  await assert.rejects(
    () => store.apply({
      preview_id: prepared.preview_id,
      expected_revision: 1,
      operation_id: 'op-crash-staged',
    }, {verify: verifyActive, crashAfter: 'staged'}),
    (error) => error?.simulated_crash === true,
  );
  assert.equal(store.loadCurrent().revision, 1);
  assert.equal(journalFor(store, 'op-crash-staged').phase, 'staged');
  const recovery = store.recover();
  assert.equal(recovery.status, 'rolled_back');
  assert.equal(store.loadCurrent().revision, 1);
  assert.deepEqual(store.listRevisions().map((revision) => revision.revision), [1]);
  assert.equal(journalFor(store, 'op-crash-staged').phase, 'recovered');
});

test('recover preserves both sides when the pointer moved outside the store', async (t) => {
  const {store} = makeStore(t, {label: 'crash-external'});
  await applyOnce(store, {op: 'op-stable'});
  const prepared = prepare(store, {selected: ['05'], expectedRevision: 1});
  await assert.rejects(
    () => store.apply({
      preview_id: prepared.preview_id,
      expected_revision: 1,
      operation_id: 'op-crash-external',
    }, {verify: verifyActive, crashAfter: 'switched'}),
    (error) => error?.simulated_crash === true,
  );
  // Someone else moves the pointer again while the journal is unresolved.
  const externalCurrent = {
    schema_version: 1,
    profile_id: FIXTURE_PROFILE_ID,
    revision: 3,
    composition_digest: sha('third-party-composition'),
    policy_digest: null,
    status: 'active',
    verified: true,
    operation_id: null,
    updated_at: new Date().toISOString(),
    verified_at: null,
  };
  nodeFs.writeFileSync(store.paths.current, `${JSON.stringify(externalCurrent, null, 2)}\n`);
  const externalBytes = nodeFs.readFileSync(store.paths.current, 'utf8');
  const recovery = store.recover();
  assert.equal(recovery.status, 'partial');
  assert.equal(recovery.recovered, false);
  assert.ok(recovery.diagnostics.some((diagnostic) => diagnostic.code === 'REVISION_CONFLICT'));
  assert.equal(nodeFs.readFileSync(store.paths.current, 'utf8'), externalBytes);
  assert.deepEqual(store.listRevisions().map((revision) => revision.revision), [1, 2]);
});

// ---------------------------------------------------------------------------
// Write failure / quiesce / honest verification
// ---------------------------------------------------------------------------

test('an ENOSPC on the pointer switch keeps the previous current intact', async (t) => {
  const root = tempRoot(t, 'enospc');
  createProfileStore({root, profile_id: FIXTURE_PROFILE_ID}); // initialize revision 0
  const failingFs = {
    ...nodeFs,
    renameSync(from, to) {
      if (String(to).endsWith('current.json')) {
        const error = new Error('ENOSPC: no space left on device, rename');
        error.code = 'ENOSPC';
        throw error;
      }
      return nodeFs.renameSync(from, to);
    },
  };
  const failingStore = createProfileStore({root, profile_id: FIXTURE_PROFILE_ID, fs: failingFs});
  const before = nodeFs.readFileSync(failingStore.paths.current, 'utf8');
  const prepared = prepare(failingStore, {expectedRevision: 0});
  assert.equal(prepared.status, 'prepared');
  const result = await failingStore.apply({
    preview_id: prepared.preview_id,
    expected_revision: 0,
    operation_id: 'op-enospc',
  }, {verify: verifyActive});
  assert.equal(result.status, 'rolled_back');
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'WRITE_FAILED'));
  assert.equal(nodeFs.readFileSync(failingStore.paths.current, 'utf8'), before);

  const healthy = createProfileStore({root, profile_id: FIXTURE_PROFILE_ID});
  assert.equal(healthy.loadCurrent().revision, 0);
  assert.deepEqual(healthy.listRevisions(), []);
  const retried = await applyOnce(healthy, {op: 'op-enospc-retry'});
  assert.equal(retried.status, 'active');
  assert.equal(healthy.loadCurrent().revision, 1);
});

test('a busy quiesce denies the switch and drops the staged revision', async (t) => {
  const {store} = makeStore(t, {label: 'quiesce'});
  const result = await applyOnce(store, {op: 'op-quiesce', quiesce: () => ({status: 'busy'})});
  assert.equal(result.status, 'denied');
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'QUIESCE_BUSY'));
  assert.equal(store.loadCurrent().revision, 0);
  assert.deepEqual(store.listRevisions(), []);
  assert.equal(journalFor(store, 'op-quiesce').phase, 'cancelled');
});

test('the default verification never claims active without runtime evidence', async (t) => {
  const {store} = makeStore(t, {label: 'default-verify'});
  const result = await applyOnce(store, {op: 'op-default', verify: null});
  assert.equal(result.status, 'restart_required');
  const current = store.loadCurrent();
  assert.equal(current.revision, 1);
  assert.equal(current.status, 'restart_required');
  assert.equal(current.verified, false);
  assert.equal(journalFor(store, 'op-default').phase, 'restart_required');
  // Replaying the identical composition stays honest: still restart_required.
  const replay = await applyOnce(store, {op: 'op-default-2', verify: null});
  assert.equal(replay.status, 'restart_required');
  assert.equal(replay.no_op, true);
});

// ---------------------------------------------------------------------------
// Tool wrappers (compose / restore)
// ---------------------------------------------------------------------------

test('restore tool recovers a crashed profile and refuses non-scratch roots', async (t) => {
  const refused = restoreScratch({scratch: ROOT});
  assert.equal(refused.exitCode, 2);
  assert.equal(refused.report.ok, false);
  assert.ok(refused.report.diagnostics.some((diagnostic) => diagnostic.code === 'PATH_UNTRUSTED'));

  const {root, store} = makeStore(t, {label: 'restore-tool'});
  await applyOnce(store, {op: 'op-stable'});
  const prepared = prepare(store, {selected: ['05'], expectedRevision: 1});
  await assert.rejects(
    () => store.apply({
      preview_id: prepared.preview_id,
      expected_revision: 1,
      operation_id: 'op-crash-restore',
    }, {verify: verifyActive, crashAfter: 'switched'}),
    (error) => error?.simulated_crash === true,
  );

  // Dry run reports the recovery without moving the pointer.
  const dry = restoreScratch({scratch: root, dryRun: true});
  assert.equal(dry.exitCode, 0);
  assert.equal(dry.report.dry_run, true);
  assert.equal(dry.report.profiles[0].status, 'rolled_back');
  assert.equal(dry.report.profiles[0].recovered, false);
  assert.equal(store.loadCurrent().revision, 2);

  const real = restoreScratch({scratch: root});
  assert.equal(real.exitCode, 0);
  assert.equal(real.report.ok, true);
  assert.equal(real.report.profiles[0].recovered, true);
  assert.equal(store.loadCurrent().revision, 1);
});

test('compose fixture CLI is scratch-only and idempotent', async (t) => {
  const root = tempRoot(t, 'compose-cli');
  const first = await composeFixture({out: root});
  assert.equal(first.exitCode, 0);
  assert.equal(first.report.status, 'active');
  assert.equal(first.report.revision, 1);
  assert.deepEqual(first.report.ordered, ['05', '07']);
  assert.deepEqual(first.report.enabled, ['05', '07']);
  assert.equal(first.report.composition_digest.length, 64);
  assert.equal(typeof first.report.preview_id, 'string');

  const second = await composeFixture({out: root});
  assert.equal(second.exitCode, 0);
  assert.equal(second.report.revision, 1);
  const store = createProfileStore({root, profile_id: FIXTURE_PROFILE_ID});
  assert.equal(store.listRevisions().length, 1);

  const refused = await composeFixture({out: ROOT});
  assert.equal(refused.exitCode, 2);
  assert.equal(refused.report.status, 'blocked');
});



