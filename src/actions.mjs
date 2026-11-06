// Navigation action service (design §6 UI-NAV-01).
//
// The Host only validates and forwards a descriptor's planOpen result. It never
// calls client layout code, never reports "opened", and a receipt is diagnostic
// only: it cannot raise a module to ready or release a transaction gate.
import {
  LIMITS,
  ContractError,
  validateActionResultV1,
  validateNavigationIntentV1,
  reasonCodeOf,
  validateTrustedContext,
  assertStableId,
  assertReasonCode,
  NAV_CLIENT_STATES,
} from './contracts.mjs';

const INTENT_TTL_MAX_MS = 5 * 60 * 1000;
const RECEIPT_STATE_TO_OPERATION = Object.freeze({
  opened: 'opened',
  instruction_shown: 'instruction_shown',
  unavailable: 'unavailable',
  stale: 'stale',
});

function actionError(status, moduleId, operationId, reasonCode) {
  return validateActionResultV1({
    schema_version: 1,
    operation_id: operationId,
    status,
    owner_module: moduleId,
    reason_code: reasonCode,
    navigation_intent: null,
  });
}

function sanitizeIntent(intent, {trusted, moduleId, registry, now}) {
  const validated = validateNavigationIntentV1(intent);
  if (validated.owner_module !== moduleId) throw new ContractError('INVALID_VALUE', 'intent.owner_module', 'intent owner must be the preparing module');
  if (validated.scope_ref !== trusted.scope_ref) throw new ContractError('STALE_SCOPE', 'intent.scope_ref', 'intent scope does not match the trusted context');
  if (validated.scope_generation !== trusted.scope_generation) throw new ContractError('STALE_SCOPE', 'intent.scope_generation', 'intent generation is stale');
  if (validated.context_revision !== trusted.context_revision) throw new ContractError('STALE_SCOPE', 'intent.context_revision', 'intent context revision is stale');
  const digest = registry.compositionDigest();
  if (digest !== null && validated.composition_digest !== digest) throw new ContractError('STALE_SCOPE', 'intent.composition_digest', 'intent composition digest is stale');
  const expiresAt = Date.parse(validated.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + INTENT_TTL_MAX_MS) {
    throw new ContractError('EXPIRED_INTENT', 'intent.expires_at', 'intent expiry must be in the near future');
  }
  if (validated.target.kind === 'panel') {
    assertStableId(validated.target.panel_key, 'intent.target.panel_key');
    if (validated.target.panel_key === 'conversation') throw new ContractError('INVALID_VALUE', 'intent.target.panel_key', 'the conversation panel is not a module target');
  }
  return validated;
}

export function createActionService({registry, access, now = () => Date.now(), maxOperations = 64} = {}) {
  const intents = new Map();
  const operations = new Map();
  let disposed = false;

  function prune() {
    const horizon = now() - 10 * 60 * 1000;
    for (const [intentId, record] of intents) if (record.prepared_at < horizon) intents.delete(intentId);
    for (const [ref, record] of operations) {
      if (record.updated_at < horizon && record.state !== 'unknown' && record.state !== 'outcome_unknown') operations.delete(ref);
    }
    while (operations.size > maxOperations) {
      const oldest = [...operations.entries()].sort((left, right) => left[1].updated_at - right[1].updated_at)[0];
      if (oldest === undefined) break;
      operations.delete(oldest[0]);
    }
  }

  function record(operationRef, fields) {
    operations.set(operationRef, {...operations.get(operationRef), ...fields, updated_at: now()});
    return operations.get(operationRef);
  }

  /** Validate + forward descriptor.planOpen. Returns ActionResultV1. */
  async function prepareNavigation({trusted: trustedRaw, module_id: moduleId, operation_id: operationId, signal}) {
    if (disposed) return actionError('unavailable', moduleId, operationId, 'NOT_READY');
    const trusted = validateTrustedContext(trustedRaw);
    const context = access.resolve({context_ref: trusted.caller_ref, expected_scope_generation: trusted.scope_generation});
    if (!context.ok) return actionError('denied', moduleId, operationId, context.reason_code);
    if (!context.entry.allowed_module_ids.includes(moduleId)) return actionError('denied', moduleId, operationId, 'MODULE_DENIED');
    const descriptor = registry.descriptorFor(moduleId);
    if (descriptor === null) return actionError('unavailable', moduleId, operationId, 'NOT_READY');
    if (signal?.aborted) return actionError('stale', moduleId, operationId, 'STALE_SCOPE');
    prune();
    let rawIntent;
    try {
      rawIntent = await descriptor.planOpen(trusted, signal ?? new AbortController().signal);
    } catch (error) {
      const reason = reasonCodeOf(error, 'INTERNAL_FAILURE');
      return actionError(reason === 'EXPIRED_INTENT' || reason === 'STALE_SCOPE' ? 'stale' : 'unavailable', moduleId, operationId, reason);
    }
    let intent;
    try {
      intent = sanitizeIntent(rawIntent, {trusted, moduleId, registry, now: now()});
    } catch (error) {
      const reason = reasonCodeOf(error, 'INTERNAL_FAILURE');
      return actionError(reason === 'STALE_SCOPE' || reason === 'EXPIRED_INTENT' ? 'stale' : 'unavailable', moduleId, operationId, reason);
    }
    if (intents.has(intent.intent_id)) return actionError('unavailable', moduleId, operationId, 'INVALID_REQUEST');
    intents.set(intent.intent_id, {module_id: moduleId, context_ref: trusted.caller_ref, prepared_at: now(), intent});
    record(operationId, {
      operation_ref: operationId,
      module_id: moduleId,
      context_ref: trusted.caller_ref,
      state: 'prepared',
      phase: 'intent_ready',
      reason_code: null,
      recovery_refs: [],
      intent_id: intent.intent_id,
    });
    return validateActionResultV1({
      schema_version: 1,
      operation_id: operationId,
      status: 'accepted',
      owner_module: moduleId,
      reason_code: null,
      navigation_intent: intent,
    });
  }

  /** Diagnostic-only receipt. Never a business success or permission proof. */
  function recordReceipt({trusted: trustedRaw, intent_id: intentId, client_state: clientState, reason_code: reasonCode = null}) {
    const trusted = validateTrustedContext(trustedRaw);
    if (!NAV_CLIENT_STATES.includes(clientState)) throw new ContractError('INVALID_VALUE', 'client_state', 'must be a navigation client state');
    assertReasonCode(reasonCode, 'reason_code');
    const prepared = intents.get(intentId);
    if (prepared === undefined || prepared.context_ref !== trusted.caller_ref) return {recorded: false};
    const operation = [...operations.values()].find((entry) => entry.intent_id === intentId);
    if (operation !== undefined) {
      record(operation.operation_ref, {
        state: RECEIPT_STATE_TO_OPERATION[clientState],
        phase: 'client_receipt',
        reason_code: reasonCode,
      });
    }
    return {recorded: true};
  }

  function getOperation({trusted: trustedRaw, operation_ref: operationRef}) {
    const trusted = validateTrustedContext(trustedRaw);
    const operation = operations.get(operationRef);
    if (operation === undefined || operation.context_ref !== trusted.caller_ref) {
      return {state: 'unknown', phase: 'unknown', reason_code: 'UNKNOWN_OPERATION', recovery_refs: []};
    }
    return {
      state: operation.state,
      phase: operation.phase,
      reason_code: operation.reason_code,
      recovery_refs: operation.recovery_refs.slice(),
    };
  }

  function markOperationOutcome(operationRef, {state, phase, reasonCode = null, recoveryRefs = []}) {
    const operation = operations.get(operationRef);
    if (operation === undefined) return false;
    record(operationRef, {state, phase, reason_code: reasonCode, recovery_refs: recoveryRefs.slice(0, LIMITS.max_refs)});
    return true;
  }

  function dispose() {
    disposed = true;
    intents.clear();
    operations.clear();
  }

  return {prepareNavigation, recordReceipt, getOperation, markOperationOutcome, dispose, operations};
}
