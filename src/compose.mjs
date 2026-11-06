// Composition apply state machine and crash recovery (T3 / UI-03).
//
// The store owns bytes on disk (revisions, current pointer, journal); this
// module owns the ordered transition
//   draft -> validated -> staged -> quiescing -> switching -> verifying -> active
// and the honest failure states. It never claims `active` without a verification
// verdict: the default verifier only re-reads bytes and therefore reports
// `restart_required` (the Host must boot the new revision).
//
// A crash (or an injected `crashAfter`) leaves the journal behind for
// recoverComposition(); recovery restores the previous revision only after
// re-proving its identity, and keeps both versions when the environment changed
// outside the store.
import {makeDiagnostic, finalizeDiagnostics} from './conflicts.mjs';

export const COMPOSE_PHASES = Object.freeze(['draft', 'validated', 'staged', 'quiescing', 'switching', 'verifying', 'active']);

export const FAILURE_PHASES = Object.freeze(['rolling_back', 'rolled_back', 'partial', 'outcome_unknown', 'failed', 'cancelled']);

/** Journal phases that mean "this operation has not reached a terminal state". */
export const UNRESOLVED_PHASES = Object.freeze(['draft', 'validated', 'staged', 'quiescing', 'switching', 'switched', 'verifying', 'rolling_back']);

export const TERMINAL_PHASES = Object.freeze(['active', 'restart_required', 'rolled_back', 'partial', 'outcome_unknown', 'failed', 'cancelled', 'no_change', 'recovered']);

const UNRESOLVED = new Set(UNRESOLVED_PHASES);
const TERMINAL = new Set(TERMINAL_PHASES);

/** Thrown by an injected crash; leaves the journal for recoverComposition(). */
export class SimulatedCrashError extends Error {
  constructor(phase) {
    super(`simulated crash after phase ${phase}`);
    this.name = 'SimulatedCrashError';
    this.simulated_crash = true;
    this.phase = phase;
    this.code = 'SIMULATED_CRASH';
  }
}

function diag(code, severity, messageKey, moduleIds = []) {
  return makeDiagnostic({code, severity, module_ids: moduleIds, resource_ref: null, message_key: messageKey});
}

function outcome(port, status, {revision, previousRevision, compositionDigest, diagnostics = [], operationId = null, previewId = null, noOp = false, extra = {}}) {
  const result = {
    status,
    revision,
    previous_revision: previousRevision,
    composition_digest: compositionDigest,
    diagnostics: finalizeDiagnostics(diagnostics),
    operation_id: operationId,
    preview_id: previewId,
    no_op: noOp,
  };
  Object.assign(result, extra);
  return result;
}

function maybeCrash(crashAfter, phase) {
  if (crashAfter === phase) throw new SimulatedCrashError(phase);
}

function safeJournal(port, entry) {
  try {
    port.writeJournal(entry);
  } catch {
    // A journal write failure is real but cannot be surfaced after the fact;
    // recovery will see whatever the last durable journal entry was.
  }
}

/** Base journal record shared by every phase of one operation. */
function journalBase(port, {preview, operationId, targetRevision, previous, previousProfileSha256}) {
  const now = port.nowIso();
  return {
    schema_version: 1,
    profile_id: port.profileId,
    operation_id: operationId,
    preview_id: preview.preview_id,
    revision: targetRevision,
    previous_revision: previous.revision,
    previous_current: {...previous},
    previous_composition_digest: previous.composition_digest,
    previous_profile_sha256: previousProfileSha256 ?? null,
    new_composition_digest: preview.profile.composition_digest,
    policy_digest: preview.profile.policy_digest,
    selected_ids: [...preview.selected_ids],
    created_at: now,
    updated_at: now,
  };
}

/**
 * Run one apply transaction. The caller (profile-store) has already validated
 * the preview, the expected revision and the idempotency key while holding the
 * single-writer lock.
 */
export async function applyComposition(port, {preview, expected_revision, operation_id, verify, quiesce, crashAfter}) {
  const current = port.loadCurrent();
  if (current.revision !== expected_revision || current.revision !== preview.expected_revision) {
    return outcome(port, 'stale', {
      revision: current.revision,
      previousRevision: current.revision,
      compositionDigest: current.composition_digest,
      diagnostics: [diag('STALE_REVISION', 'error', 'compose.stale_revision')],
      operationId: operation_id,
      previewId: preview.preview_id,
    });
  }
  const targetRevision = current.revision + 1;
  const profile = {...preview.profile, revision: targetRevision};
  let previousProfile = null;
  if (current.revision > 0) {
    try {
      previousProfile = port.readRevisionProfile(current.revision);
    } catch {
      previousProfile = null;
    }
  }
  if (current.revision > 0 && previousProfile === null) {
    return outcome(port, 'denied', {
      revision: current.revision,
      previousRevision: current.revision,
      compositionDigest: current.composition_digest,
      diagnostics: [diag('JOURNAL_CORRUPT', 'error', 'compose.previous_revision_unreadable')],
      operationId: operation_id,
      previewId: preview.preview_id,
    });
  }
  const base = journalBase(port, {
    preview,
    operationId: operation_id,
    targetRevision,
    previous: current,
    previousProfileSha256: previousProfile?.sha256 ?? null,
  });

  safeJournal(port, {...base, phase: 'validated'});
  maybeCrash(crashAfter, 'validated');

  let stagedName = null;
  let committed = false;
  try {
    // --- staged: write an unreferenced revision directory, fsync it, seal it.
    stagedName = port.stageRevision(profile, preview.patch_text, operation_id);
    safeJournal(port, {...base, phase: 'staged', staged_name: stagedName});
    maybeCrash(crashAfter, 'staged');

    // --- quiescing: only idle modules may be switched. No forced unload.
    safeJournal(port, {...base, phase: 'quiescing', staged_name: stagedName});
    const quiesceHook = typeof quiesce === 'function' ? quiesce : port.defaultQuiesce;
    let quiesceResult = {status: 'idle'};
    try {
      quiesceResult = await quiesceHook({operation_id, ordered: profile.module_refs.map((ref) => ref.id)});
    } catch {
      quiesceResult = {status: 'unknown'};
    }
    if (!quiesceResult || quiesceResult.status !== 'idle') {
      const busy = quiesceResult?.status === 'busy';
      const code = busy ? 'QUIESCE_BUSY' : 'QUIESCE_UNKNOWN';
      safeJournal(port, {...base, phase: 'cancelled', staged_name: stagedName, reason_code: code});
      port.removeStaged(stagedName);
      return outcome(port, 'denied', {
        revision: current.revision,
        previousRevision: current.revision,
        compositionDigest: current.composition_digest,
        diagnostics: [diag(code, 'error', busy ? 'compose.quiesce_busy' : 'compose.quiesce_unknown', profile.module_refs.map((ref) => ref.id))],
        operationId: operation_id,
        previewId: preview.preview_id,
      });
    }
    maybeCrash(crashAfter, 'quiescing');

    // --- switching: seal the revision directory, then atomically swap the
    //     current pointer. Both stay on the same volume (same profile root).
    safeJournal(port, {...base, phase: 'switching', staged_name: stagedName});
    port.commitRevision(stagedName, targetRevision);
    stagedName = null;
    committed = true;
    maybeCrash(crashAfter, 'committed');

    const switchedPointer = {
      schema_version: 1,
      profile_id: port.profileId,
      revision: targetRevision,
      composition_digest: profile.composition_digest,
      policy_digest: profile.policy_digest,
      status: 'switching',
      verified: false,
      operation_id,
      updated_at: port.nowIso(),
      verified_at: null,
    };
    port.writeCurrent(switchedPointer);
    safeJournal(port, {...base, phase: 'switched'});
    maybeCrash(crashAfter, 'switched');

    // --- verifying: injected verifier, or the default byte/digest re-read.
    safeJournal(port, {...base, phase: 'verifying'});
    maybeCrash(crashAfter, 'verifying');
    let verdict;
    try {
      verdict = await (typeof verify === 'function' ? verify : port.defaultVerify)({revision: targetRevision, profile, operation_id});
    } catch {
      verdict = {status: 'failed', reason_code: 'INTERNAL_FAILURE'};
    }
    if (!verdict || typeof verdict.status !== 'string') verdict = {status: 'failed', reason_code: 'INTERNAL_FAILURE'};
    const verdictDiagnostics = Array.isArray(verdict.diagnostics) ? verdict.diagnostics : [];

    if (verdict.status === 'failed') {
      const restored = port.restoreCurrent(current);
      if (!restored || restored.ok !== true) {
        safeJournal(port, {...base, phase: 'partial', reason_code: 'WRITE_FAILED'});
        return outcome(port, 'partial', {
          revision: targetRevision,
          previousRevision: current.revision,
          compositionDigest: profile.composition_digest,
          diagnostics: [...verdictDiagnostics, diag('WRITE_FAILED', 'error', 'compose.rollback_failed', profile.module_refs.map((ref) => ref.id))],
          operationId: operation_id,
          previewId: preview.preview_id,
        });
      }
      safeJournal(port, {...base, phase: 'rolled_back', reason_code: verdict.reason_code ?? 'INTERNAL_FAILURE'});
      return outcome(port, 'rolled_back', {
        revision: current.revision,
        previousRevision: current.revision,
        compositionDigest: current.composition_digest,
        diagnostics: [...verdictDiagnostics, diag('ROLLED_BACK', 'warning', 'compose.rolled_back_after_verification_failure')],
        operationId: operation_id,
        previewId: preview.preview_id,
      });
    }

    const finalStatus = verdict.status === 'active' ? 'active' : 'restart_required';
    const verifiedPointer = {
      ...switchedPointer,
      status: finalStatus,
      verified: finalStatus === 'active',
      verified_at: port.nowIso(),
      updated_at: port.nowIso(),
    };
    try {
      port.writeCurrent(verifiedPointer);
    } catch {
      // The pointer already names the new revision but the verified marker did
      // not persist: do not pretend the result is known.
      safeJournal(port, {...base, phase: 'outcome_unknown', reason_code: 'WRITE_FAILED'});
      return outcome(port, 'outcome_unknown', {
        revision: targetRevision,
        previousRevision: current.revision,
        compositionDigest: profile.composition_digest,
        diagnostics: [...verdictDiagnostics, diag('OUTCOME_UNKNOWN', 'error', 'compose.verified_pointer_write_failed')],
        operationId: operation_id,
        previewId: preview.preview_id,
      });
    }
    safeJournal(port, {...base, phase: finalStatus, finalized_at: port.nowIso()});
    return outcome(port, finalStatus, {
      revision: targetRevision,
      previousRevision: current.revision,
      compositionDigest: profile.composition_digest,
      diagnostics: verdictDiagnostics,
      operationId: operation_id,
      previewId: preview.preview_id,
    });
  } catch (error) {
    if (error instanceof SimulatedCrashError || error?.simulated_crash === true) throw error;
    safeJournal(port, {...base, phase: 'failed', reason_code: 'WRITE_FAILED'});
    if (stagedName !== null) {
      try {
        port.removeStaged(stagedName);
      } catch {
        // best effort: recover() cleans unreferenced staged directories.
      }
    }
    let after = current;
    try {
      after = port.loadCurrent();
    } catch {
      after = current;
    }
    if (!committed || after.revision !== targetRevision) {
      // The pointer still (or again) names the previous revision. The new
      // revision directory was never referenced, so it is safe to drop.
      if (committed) {
        try {
          port.removeRevisionDir(targetRevision);
        } catch {
          // preserved for recover() to clean.
        }
      }
      return outcome(port, 'rolled_back', {
        revision: after.revision,
        previousRevision: current.revision,
        compositionDigest: after.composition_digest,
        diagnostics: [diag('WRITE_FAILED', 'error', 'compose.write_failed_previous_current_kept', profile.module_refs.map((ref) => ref.id))],
        operationId: operation_id,
        previewId: preview.preview_id,
      });
    }
    // The pointer switched but verification never completed; the journal stays
    // unresolved for recover().
    return outcome(port, 'outcome_unknown', {
      revision: targetRevision,
      previousRevision: current.revision,
      compositionDigest: profile.composition_digest,
      diagnostics: [diag('OUTCOME_UNKNOWN', 'error', 'compose.apply_interrupted_after_switch')],
      operationId: operation_id,
      previewId: preview.preview_id,
    });
  }
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

function previousIdentity(port, entry) {
  const previous = entry.previous_current;
  if (!previous || typeof previous !== 'object') return {ok: false, reason: 'previous_current_missing'};
  if (previous.revision === 0) {
    const emptyDigest = port.emptyCompositionDigest;
    if (previous.composition_digest !== emptyDigest) return {ok: false, reason: 'previous_revision_zero_digest_mismatch'};
    return {ok: true};
  }
  let revisionProfile;
  try {
    revisionProfile = port.readRevisionProfile(previous.revision);
  } catch {
    return {ok: false, reason: 'previous_revision_unreadable'};
  }
  if (!revisionProfile || !revisionProfile.profile) return {ok: false, reason: 'previous_revision_missing'};
  if (revisionProfile.profile.composition_digest !== previous.composition_digest) return {ok: false, reason: 'previous_composition_digest_mismatch'};
  if (revisionProfile.profile.revision !== previous.revision) return {ok: false, reason: 'previous_revision_mismatch'};
  if (typeof entry.previous_profile_sha256 === 'string' && revisionProfile.sha256 !== entry.previous_profile_sha256) {
    return {ok: false, reason: 'previous_profile_sha256_mismatch'};
  }
  return {ok: true};
}

function partialResult(port, current, entry, messageKey, extraDiagnostics = [], actions = ['preserved_both_revisions']) {
  return {
    status: 'partial',
    revision: current.revision,
    previous_revision: current.revision,
    composition_digest: current.composition_digest,
    diagnostics: finalizeDiagnostics([diag('PARTIAL', 'error', messageKey, entry?.selected_ids ?? []), ...extraDiagnostics]),
    recovered: false,
    dry_run: false,
    actions,
    operation_id: entry?.operation_id ?? null,
  };
}

function restorePreviousRevision(port, current, entry, diagnostics, actions, dry_run) {
  const identity = previousIdentity(port, entry);
  if (!identity.ok) {
    return partialResult(port, current, entry, 'compose.previous_identity_unverified', [diag('JOURNAL_CORRUPT', 'error', 'compose.journal_identity_unverified', entry.selected_ids ?? [])], ['preserved_both_revisions', identity.reason]);
  }
  const target = {...entry.previous_current};
  if (dry_run) {
    return {
      status: 'rolled_back',
      revision: target.revision,
      previous_revision: target.revision,
      composition_digest: target.composition_digest,
      diagnostics: finalizeDiagnostics([diag('ROLLED_BACK', 'warning', 'compose.would_restore_previous_revision', entry.selected_ids ?? [])]),
      recovered: false,
      dry_run: true,
      actions: [...actions, 'would_restore_previous_revision'],
      operation_id: entry.operation_id,
    };
  }
  const restored = port.restoreCurrent(target);
  if (!restored || restored.ok !== true) {
    return {
      status: 'outcome_unknown',
      revision: current.revision,
      previous_revision: current.revision,
      composition_digest: current.composition_digest,
      diagnostics: finalizeDiagnostics([diag('WRITE_FAILED', 'error', 'compose.restore_current_failed', entry.selected_ids ?? []), ...diagnostics]),
      recovered: false,
      dry_run: false,
      actions: [...actions, 'restore_failed'],
      operation_id: entry.operation_id,
    };
  }
  safeJournal(port, {...entry, phase: 'rolled_back', reason_code: 'ROLLED_BACK', updated_at: port.nowIso()});
  return {
    status: 'rolled_back',
    revision: target.revision,
    previous_revision: target.revision,
    composition_digest: target.composition_digest,
    diagnostics: finalizeDiagnostics([diag('ROLLED_BACK', 'warning', 'compose.rolled_back_after_crash', entry.selected_ids ?? []), ...diagnostics]),
    recovered: true,
    dry_run: false,
    actions: [...actions, 'restored_previous_revision'],
    operation_id: entry.operation_id,
  };
}

/**
 * Resolve at most one unresolved journal entry. Multiple unresolved entries or
 * unreadable journals are reported as `partial` and every version is preserved:
 * the tool never overwrites a configuration it cannot prove it wrote itself.
 */
export function recoverComposition(port, options = {}) {
  const dryRun = options.dry_run === true;
  let current;
  try {
    current = port.loadCurrent();
  } catch {
    return {
      status: 'partial',
      revision: null,
      previous_revision: null,
      composition_digest: null,
      diagnostics: finalizeDiagnostics([diag('JOURNAL_CORRUPT', 'error', 'compose.current_pointer_unreadable')]),
      recovered: false,
      dry_run: dryRun,
      actions: ['current_unreadable'],
      operation_id: null,
    };
  }

  const journal = port.readJournalTolerant();
  if (journal.corrupt.length > 0) {
    return partialResult(port, current, null, 'compose.journal_corrupt', [diag('JOURNAL_CORRUPT', 'error', 'compose.journal_corrupt_unreadable')], ['preserved_all_files']);
  }
  const unresolved = journal.entries
    .filter((entry) => UNRESOLVED.has(entry.phase))
    .sort((left, right) => (left.created_at < right.created_at ? -1 : left.created_at > right.created_at ? 1 : 0));

  if (unresolved.length === 0) {
    if (current.status === 'switching') {
      return {
        status: 'outcome_unknown',
        revision: current.revision,
        previous_revision: current.revision,
        composition_digest: current.composition_digest,
        diagnostics: finalizeDiagnostics([diag('OUTCOME_UNKNOWN', 'error', 'compose.pointer_switching_without_journal')]),
        recovered: false,
        dry_run: dryRun,
        actions: [],
        operation_id: null,
      };
    }
    const status = current.status === 'restart_required' ? 'restart_required' : 'active';
    return {
      status,
      revision: current.revision,
      previous_revision: current.revision,
      composition_digest: current.composition_digest,
      diagnostics: [],
      recovered: false,
      dry_run: dryRun,
      actions: [],
      operation_id: null,
    };
  }
  if (unresolved.length > 1) {
    return partialResult(port, current, unresolved[unresolved.length - 1], 'compose.multiple_unresolved_journals', [], ['preserved_all_files']);
  }

  const entry = unresolved[0];
  const pointerNamesNew = current.revision === entry.revision;
  const pointerNamesPrevious = current.revision === entry.previous_revision;
  if (!pointerNamesNew && !pointerNamesPrevious) {
    // Some other writer moved the profile; keep both sides untouched.
    return partialResult(port, current, entry, 'compose.external_change_preserved', [diag('REVISION_CONFLICT', 'error', 'compose.external_revision_change', entry.selected_ids ?? [])], ['preserved_both_revisions']);
  }
  if (pointerNamesNew && current.composition_digest !== entry.new_composition_digest) {
    return partialResult(port, current, entry, 'compose.external_change_preserved', [diag('REVISION_CONFLICT', 'error', 'compose.external_composition_change', entry.selected_ids ?? [])], ['preserved_both_revisions']);
  }

  if (pointerNamesPrevious) {
    // The pointer never moved (or already moved back): drop the unreferenced
    // revision directory and finalize the journal.
    const actions = ['kept_previous_revision'];
    if (!dryRun) {
      if (typeof entry.staged_name === 'string') {
        try {
          port.removeStaged(entry.staged_name);
        } catch {
          // already gone
        }
      }
      try {
        port.removeRevisionDir(entry.revision);
      } catch {
        // nothing to clean
      }
      safeJournal(port, {...entry, phase: 'recovered', reason_code: 'ROLLED_BACK', updated_at: port.nowIso()});
    }
    actions.push('removed_unreferenced_revision');
    return {
      status: 'rolled_back',
      revision: current.revision,
      previous_revision: current.revision,
      composition_digest: current.composition_digest,
      diagnostics: finalizeDiagnostics([diag('ROLLED_BACK', 'warning', 'compose.recovered_without_switch', entry.selected_ids ?? [])]),
      recovered: !dryRun,
      dry_run: dryRun,
      actions,
      operation_id: entry.operation_id,
    };
  }

  // The pointer names the new revision but the operation never verified:
  // restore the saved previous revision after re-proving its identity.
  return restorePreviousRevision(port, current, entry, [], ['kept_new_revision_for_audit'], dryRun);
}

/**
 * Interpret a terminal journal entry as the idempotent replay answer for a
 * repeated (operation_id, composition_digest) apply. No revision is written.
 */
export function describeJournalOutcome(journal, current) {
  const replay = diag('NO_CHANGE', 'info', 'compose.idempotent_replay');
  const base = {
    revision: journal.revision,
    previous_revision: journal.previous_revision,
    composition_digest: journal.new_composition_digest,
    diagnostics: [replay],
    operation_id: journal.operation_id,
    preview_id: journal.preview_id ?? null,
    no_op: true,
    idempotent_replay: true,
  };
  switch (journal.phase) {
    case 'active':
      return {...base, status: 'active'};
    case 'restart_required':
      return {...base, status: 'restart_required'};
    case 'no_change':
      return {
        ...base,
        status: current.status === 'restart_required' ? 'restart_required' : 'active',
        revision: journal.previous_revision,
        previous_revision: journal.previous_revision,
        composition_digest: journal.previous_composition_digest ?? current.composition_digest,
      };
    case 'partial':
      return {...base, status: 'partial'};
    case 'outcome_unknown':
      return {...base, status: 'outcome_unknown'};
    case 'cancelled':
      return {
        ...base,
        status: 'denied',
        revision: journal.previous_revision,
        composition_digest: journal.previous_composition_digest,
        diagnostics: [diag(journal.reason_code === 'QUIESCE_BUSY' ? 'QUIESCE_BUSY' : 'QUIESCE_UNKNOWN', 'error', 'compose.quiesce_cancelled')],
      };
    case 'failed':
    case 'recovered':
    case 'rolled_back':
    default:
      return {
        ...base,
        status: 'rolled_back',
        revision: journal.previous_revision,
        composition_digest: journal.previous_composition_digest,
        diagnostics: [replay, diag('ROLLED_BACK', 'warning', 'compose.rolled_back_replay')],
      };
  }
}

export function isTerminalPhase(phase) {
  return TERMINAL.has(phase);
}

export function isUnresolvedPhase(phase) {
  return UNRESOLVED.has(phase);
}
