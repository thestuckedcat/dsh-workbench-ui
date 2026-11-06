// Host RPC surface for the workbench (design §6 UI-RPC-01).
//
// Transport shape: the pinned connection wraps the returned BusinessResponse in
// `{ok:true,value}` (or `{ok:false,error}` at transport level). Business
// rejections are values, never thrown errors: every handler path returns a
// validated BusinessResponse and the catch-all maps to a fixed reason code
// without String(error), paths, profile ids or secrets.
import {
  LIMITS,
  ContractError,
  decodedJsonBytes,
  reasonCodeOf,
  validateActionResultV1,
  validateBusinessResponseV1,
  validateRpcRequestV1,
  validateTrustedContext,
  validatePrepareRequest,
  assertReasonCode,
  BUSINESS_STATUSES,
} from './contracts.mjs';
import {isOwnerPeer} from './access.mjs';

/** Reserved context_ref used only for the bootstrap context discovery call. */
export const BOOTSTRAP_CONTEXT_REF = 'bootstrap';

const ENDPOINTS = Object.freeze(['context.list', 'status.get', 'navigation.prepare', 'navigation.receipt', 'composition.preview', 'composition.apply', 'operation.get']);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strictInput(input, path, allowed, required = []) {
  if (!isObject(input)) throw new ContractError('INVALID_TYPE', path, 'input must be a plain object');
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new ContractError('UNKNOWN_FIELD', `${path}.${key}`, 'unknown input field is rejected');
  for (const key of required) if (!(key in input)) throw new ContractError('MISSING_FIELD', `${path}.${key}`, 'required input field is missing');
  return input;
}

function inputAfterRevision(input) {
  strictInput(input, 'input', ['after_revision']);
  if (!('after_revision' in input)) return null;
  if (!Number.isSafeInteger(input.after_revision) || input.after_revision < 0) throw new ContractError('INVALID_VALUE', 'input.after_revision', 'must be a non-negative integer');
  return input.after_revision;
}

function inputNavigationPrepare(input) {
  strictInput(input, 'input', ['module_id'], ['module_id']);
  if (typeof input.module_id !== 'string' || !/^0[1-8]$/.test(input.module_id)) throw new ContractError('INVALID_VALUE', 'input.module_id', 'must be a module id');
  return input;
}

function inputNavigationReceipt(input) {
  strictInput(input, 'input', ['intent_id', 'client_state', 'reason_code'], ['intent_id', 'client_state']);
  if (typeof input.intent_id !== 'string' || input.intent_id.length === 0 || input.intent_id.length > LIMITS.max_short_text) throw new ContractError('INVALID_VALUE', 'input.intent_id', 'must be a stable id');
  if (!['opened', 'instruction_shown', 'unavailable', 'stale'].includes(input.client_state)) throw new ContractError('INVALID_VALUE', 'input.client_state', 'must be a navigation client state');
  assertReasonCode(input.reason_code ?? null, 'input.reason_code');
  return input;
}

function inputCompositionPreview(input) {
  return validatePrepareRequest(input, 'input');
}

function inputCompositionApply(input) {
  // The RPC input is {preview_id, expected_revision}; operation_id is taken
  // from the request shell by the connection, not re-supplied by the client.
  strictInput(input, 'input', ['preview_id', 'expected_revision'], ['preview_id', 'expected_revision']);
  if (typeof input.preview_id !== 'string' || input.preview_id.length === 0 || input.preview_id.length > LIMITS.max_short_text) throw new ContractError('INVALID_VALUE', 'input.preview_id', 'must be a stable preview id');
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) throw new ContractError('INVALID_VALUE', 'input.expected_revision', 'must be a non-negative integer');
  return input;
}

function inputOperationGet(input) {
  strictInput(input, 'input', ['operation_ref'], ['operation_ref']);
  if (typeof input.operation_ref !== 'string' || input.operation_ref.length === 0 || input.operation_ref.length > LIMITS.max_short_text) throw new ContractError('INVALID_VALUE', 'input.operation_ref', 'must be a stable reference');
  return input;
}

const INPUT_VALIDATORS = Object.freeze({
  'context.list': (input) => strictInput(input, 'input', []),
  'status.get': inputAfterRevision,
  'navigation.prepare': inputNavigationPrepare,
  'navigation.receipt': inputNavigationReceipt,
  'composition.preview': inputCompositionPreview,
  'composition.apply': inputCompositionApply,
  'operation.get': inputOperationGet,
});

function statusForReason(reasonCode) {
  if (reasonCode === 'STALE_SCOPE' || reasonCode === 'STALE_REVISION' || reasonCode === 'STALE_PREVIEW' || reasonCode === 'EXPIRED_INTENT') return 'stale';
  if (reasonCode === 'OWNER_REQUIRED' || reasonCode === 'CONTEXT_UNBOUND' || reasonCode === 'SCOPE_REVOKED' || reasonCode === 'PROFILE_DENIED' || reasonCode === 'MODULE_DENIED') return 'denied';
  if (reasonCode === 'INVALID_REQUEST' || reasonCode === 'INVALID_INPUT' || reasonCode === 'LIMIT_EXCEEDED' || reasonCode === 'UNKNOWN_ENDPOINT') return 'invalid';
  if (reasonCode === 'NOT_READY' || reasonCode === 'UNKNOWN_OPERATION' || reasonCode === 'PROFILE_NOT_FOUND') return 'unavailable';
  return 'failed';
}

function mapThrown(error) {
  if (error instanceof ContractError) {
    const reason = reasonCodeOf(error, 'INVALID_REQUEST');
    return {status: statusForReason(reason), reason_code: reason};
  }
  const reason = reasonCodeOf(error, 'INTERNAL_FAILURE');
  return {status: statusForReason(reason === 'INTERNAL_FAILURE' ? 'INTERNAL_FAILURE' : reason), reason_code: reason};
}

export function createRpcHandler({access, registry, actions, compose, fixtures = false, catalog = [], now = () => Date.now()} = {}) {
  if (access === undefined || registry === undefined || actions === undefined) throw new TypeError('createRpcHandler requires access, registry and actions');

  function ok(request, trusted, data) {
    return validateBusinessResponseV1({
      schema_version: 1,
      operation_id: request.operation_id,
      view_epoch: request.view_epoch,
      scope_generation: trusted?.scope_generation ?? request.expected_scope_generation,
      status: 'ok',
      data,
    });
  }

  function failure(request, status, reasonCode, scopeGeneration) {
    assertReasonCode(reasonCode);
    return validateBusinessResponseV1({
      schema_version: 1,
      operation_id: request.operation_id,
      view_epoch: request.view_epoch,
      scope_generation: scopeGeneration ?? request.expected_scope_generation,
      status,
      reason_code: reasonCode,
    });
  }

  function malformed(operationId, viewEpoch, reasonCode, status = 'invalid') {
    return validateBusinessResponseV1({
      schema_version: 1,
      operation_id: typeof operationId === 'string' && operationId.length > 0 && operationId.length <= LIMITS.max_short_text ? operationId : 'invalid-request',
      view_epoch: Number.isSafeInteger(viewEpoch) && viewEpoch >= 0 ? viewEpoch : 0,
      scope_generation: 1,
      status,
      reason_code: reasonCode,
    });
  }

  function resolveContext(request, peer) {
    if (!isOwnerPeer(peer)) return {ok: false, reason_code: 'OWNER_REQUIRED'};
    if (request.context_ref === BOOTSTRAP_CONTEXT_REF) return {ok: true, bootstrap: true};
    const resolved = access.resolve({context_ref: request.context_ref, expected_scope_generation: request.expected_scope_generation});
    if (!resolved.ok) return {ok: false, reason_code: resolved.reason_code};
    return {ok: true, entry: resolved.entry, trusted: access.toTrustedContext(resolved.entry)};
  }

  async function dispatch(endpoint, request, signal, peer) {
    const contextual = endpoint !== 'context.list';
    const resolved = contextual ? resolveContext(request, peer) : (isOwnerPeer(peer) ? {ok: true, bootstrap: true} : {ok: false, reason_code: 'OWNER_REQUIRED'});
    if (!resolved.ok) return failure(request, 'denied', resolved.reason_code);

    if (endpoint === 'context.list') {
      const listing = access.listForOwner(peer);
      if (!listing.ok) return failure(request, 'denied', listing.reason_code);
      const diagnostics = registry.currentDiagnostics();
      return ok(request, {scope_generation: request.expected_scope_generation}, {
        contexts: listing.contexts,
        diagnostics,
        fixture_mode: fixtures === true,
        modules: catalog,
      });
    }

    const trusted = validateTrustedContext(resolved.trusted);
    const entry = resolved.entry;
    switch (endpoint) {
      case 'status.get': {
        const afterRevision = request.input.after_revision ?? null;
        const allowed = new Set(entry.allowed_module_ids);
        const snapshot = await registry.snapshot(trusted, {after_revision: afterRevision, context_ref: entry.context_ref});
        const modules = snapshot.modules.filter((module) => allowed.has(module.module_id));
        return ok(request, trusted, {
          changed: snapshot.changed,
          revision: snapshot.revision,
          scope_ref: trusted.scope_ref,
          scope_generation: trusted.scope_generation,
          context_revision: trusted.context_revision,
          diagnostics: snapshot.diagnostics,
          modules,
        });
      }
      case 'navigation.prepare': {
        const result = await actions.prepareNavigation({trusted, module_id: request.input.module_id, operation_id: request.operation_id, signal});
        return ok(request, trusted, result);
      }
      case 'navigation.receipt': {
        const receipt = actions.recordReceipt({trusted, intent_id: request.input.intent_id, client_state: request.input.client_state, reason_code: request.input.reason_code ?? null});
        return ok(request, trusted, {recorded: receipt.recorded});
      }
      case 'composition.preview': {
        if (compose === undefined || typeof compose.preview !== 'function') return failure(request, 'unavailable', 'PROFILE_NOT_FOUND');
        if (!access.profileAllowed(request.input.profile_ref)) return failure(request, 'denied', 'PROFILE_DENIED');
        const data = await compose.preview({trusted, entry, input: request.input, operation_id: request.operation_id, signal});
        return ok(request, trusted, data);
      }
      case 'composition.apply': {
        if (compose === undefined || typeof compose.apply !== 'function') return failure(request, 'unavailable', 'PROFILE_NOT_FOUND');
        const data = await compose.apply({trusted, entry, input: request.input, operation_id: request.operation_id, signal});
        return ok(request, trusted, data);
      }
      case 'operation.get': {
        const operation = actions.getOperation({trusted, operation_ref: request.input.operation_ref});
        return ok(request, trusted, operation);
      }
      default:
        return failure(request, 'invalid', 'UNKNOWN_ENDPOINT');
    }
  }

  /**
   * Connection RPC handler. Returns a BusinessResponse value for every path;
   * transport-level failures stay inside the connection's own `{ok:false}`.
   */
  async function handler(endpoint, payload, signal, peer) {
    const operationId = isObject(payload) && typeof payload.operation_id === 'string' ? payload.operation_id : 'invalid-request';
    const viewEpoch = isObject(payload) && Number.isSafeInteger(payload.view_epoch) ? payload.view_epoch : 0;
    try {
      if (typeof endpoint !== 'string' || !ENDPOINTS.includes(endpoint)) return malformed(operationId, viewEpoch, 'UNKNOWN_ENDPOINT');
      if (decodedJsonBytes(payload) > LIMITS.max_request_bytes) return malformed(operationId, viewEpoch, 'LIMIT_EXCEEDED');
      const request = validateRpcRequestV1(payload);
      INPUT_VALIDATORS[endpoint](request.input);
      if (request.context_ref === BOOTSTRAP_CONTEXT_REF && endpoint !== 'context.list') return failure(request, 'denied', 'CONTEXT_UNBOUND');
      const result = await dispatch(endpoint, request, signal, peer);
      const size = decodedJsonBytes(result);
      if (size > LIMITS.max_response_bytes) return failure(request, 'failed', 'LIMIT_EXCEEDED');
      return result;
    } catch (error) {
      const mapped = mapThrown(error);
      try {
        return malformed(operationId, viewEpoch, mapped.reason_code, mapped.status);
      } catch {
        // Last-resort fixed envelope; still no error text.
        return {schema_version: 1, operation_id: 'invalid-request', view_epoch: 0, scope_generation: 1, status: 'failed', reason_code: 'INTERNAL_FAILURE'};
      }
    }
  }

  return {handler, endpoints: ENDPOINTS.slice(), now};
}

/** Validate an endpoint's data object against the endpoint contract. */
export function validateEndpointData(endpoint, data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new ContractError('INVALID_TYPE', 'data', 'endpoint data must be an object');
  switch (endpoint) {
    case 'context.list':
      if (!Array.isArray(data.contexts)) throw new ContractError('INVALID_TYPE', 'data.contexts', 'must be an array');
      if (!Array.isArray(data.diagnostics)) throw new ContractError('INVALID_TYPE', 'data.diagnostics', 'must be an array');
      if (typeof data.fixture_mode !== 'boolean') throw new ContractError('INVALID_TYPE', 'data.fixture_mode', 'must be a boolean');
      if (!Array.isArray(data.modules)) throw new ContractError('INVALID_TYPE', 'data.modules', 'must be an array');
      return data;
    case 'status.get':
      if (typeof data.changed !== 'boolean') throw new ContractError('INVALID_TYPE', 'data.changed', 'must be a boolean');
      if (!Number.isSafeInteger(data.revision)) throw new ContractError('INVALID_TYPE', 'data.revision', 'must be an integer');
      if (!Array.isArray(data.modules)) throw new ContractError('INVALID_TYPE', 'data.modules', 'must be an array');
      return data;
    case 'navigation.prepare':
      return validateActionResultV1(data);
    case 'navigation.receipt':
      if (typeof data.recorded !== 'boolean') throw new ContractError('INVALID_TYPE', 'data.recorded', 'must be a boolean');
      return data;
    case 'composition.preview':
      if (typeof data.preview_id !== 'string') throw new ContractError('INVALID_TYPE', 'data.preview_id', 'must be a string');
      if (typeof data.composition_digest !== 'string') throw new ContractError('INVALID_TYPE', 'data.composition_digest', 'must be a digest');
      if (data.diff === null || typeof data.diff !== 'object') throw new ContractError('INVALID_TYPE', 'data.diff', 'must be an object');
      return data;
    case 'composition.apply':
      if (!['active', 'stale', 'denied', 'restart_required', 'rolled_back', 'partial', 'outcome_unknown'].includes(data.status)) throw new ContractError('INVALID_VALUE', 'data.status', 'must be a composition status');
      return data;
    case 'operation.get':
      if (typeof data.state !== 'string') throw new ContractError('INVALID_TYPE', 'data.state', 'must be a string');
      return data;
    default:
      return data;
  }
}

// Re-exported so callers can reuse the same fixed envelope statuses.
export {BUSINESS_STATUSES};
