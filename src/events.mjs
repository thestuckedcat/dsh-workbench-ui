// Cross-module status events v1 (design §9) and the bounded aggregation log.
//
// Events carry no body text and never substitute for getStatus: a missing event
// must not be read as "idle". Consumers dedupe by event_id, keep the highest
// generation/revision per (module_id, scope_ref), and re-read on a gap.
import {LIMITS, ContractError, isPlainObject} from './contracts.mjs';

const EVENT_KINDS = ['status_changed', 'needs_attention', 'disposed'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODULE_ID = /^0[1-8]$/;

function fail(path, message) {
  throw new ContractError('INVALID_EVENT', path, message);
}

export function validateStatusEvent(value, path = 'event') {
  if (!isPlainObject(value)) fail(path, 'must be a plain object');
  const allowed = ['schema_version', 'event_id', 'module_id', 'scope_ref', 'session_ref', 'generation', 'revision', 'operation_id', 'kind', 'occurred_at'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'unknown field is rejected');
  for (const key of ['schema_version', 'event_id', 'module_id', 'scope_ref', 'generation', 'revision', 'kind', 'occurred_at']) {
    if (!(key in value)) fail(`${path}.${key}`, 'required field is missing');
  }
  if (value.schema_version !== 1) fail(`${path}.schema_version`, 'must be 1');
  if (typeof value.event_id !== 'string' || !STABLE_ID.test(value.event_id)) fail(`${path}.event_id`, 'must be a stable id');
  if (typeof value.module_id !== 'string' || !MODULE_ID.test(value.module_id)) fail(`${path}.module_id`, 'must be a module id');
  if (typeof value.scope_ref !== 'string' || value.scope_ref.length === 0 || value.scope_ref.length > LIMITS.max_text) fail(`${path}.scope_ref`, 'must be a scope reference');
  if (value.session_ref !== undefined && value.session_ref !== null && (typeof value.session_ref !== 'string' || value.session_ref.length > LIMITS.max_text)) fail(`${path}.session_ref`, 'must be a reference or null');
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) fail(`${path}.generation`, 'must be a non-negative integer');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) fail(`${path}.revision`, 'must be a non-negative integer');
  if (value.operation_id !== undefined && (typeof value.operation_id !== 'string' || value.operation_id.length > LIMITS.max_short_text)) fail(`${path}.operation_id`, 'must be a stable reference');
  if (!EVENT_KINDS.includes(value.kind)) fail(`${path}.kind`, 'must be a registered kind');
  if (typeof value.occurred_at !== 'string' || !ISO.test(value.occurred_at)) fail(`${path}.occurred_at`, 'must be an ISO UTC timestamp');
  return value;
}

/**
 * Bounded event log. It rejects out-of-order/duplicate events per
 * (module_id, scope_ref) and reports a gap so the caller can re-read status
 * instead of inferring idleness.
 */
export function createEventLog({limit = 256, now = () => new Date().toISOString()} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024) throw new TypeError('event log limit must be 1..1024');
  const seen = new Set();
  const latest = new Map();
  const events = [];
  const listeners = new Set();
  const keyOf = (event) => `${event.module_id}\u0000${event.scope_ref}`;

  function push(rawEvent) {
    const event = validateStatusEvent(rawEvent);
    if (seen.has(event.event_id)) return {accepted: false, duplicate: true, gap: false};
    const key = keyOf(event);
    const previous = latest.get(key);
    if (previous !== undefined) {
      if (event.generation < previous.generation) return {accepted: false, duplicate: false, gap: false, stale: true};
      if (event.generation === previous.generation && event.revision <= previous.revision) {
        return {accepted: false, duplicate: false, gap: false, stale: true};
      }
      if (event.generation > previous.generation + 1) {
        seen.add(event.event_id);
        latest.set(key, {generation: event.generation, revision: event.revision});
        return {accepted: true, duplicate: false, gap: true};
      }
    }
    seen.add(event.event_id);
    latest.set(key, {generation: event.generation, revision: event.revision});
    events.push(event);
    if (events.length > limit) {
      const removed = events.shift();
      seen.delete(removed.event_id);
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A listener failure must not break the event log; the revision bump
        // already happened and consumers re-read on their own.
      }
    }
    void now;
    return {accepted: true, duplicate: false, gap: false};
  }

  function snapshot() {
    return events.slice();
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function clear() {
    seen.clear();
    latest.clear();
    events.length = 0;
    listeners.clear();
  }

  return {push, snapshot, subscribe, clear, size: () => events.length};
}
