// Workbench HTTP RPC carrier (UI-RPC-01 runtime adaptation).
//
// Why not `ctx.connection.rpc.handle` / `.intercept`: both are registered
// through the connection service's own fiber, which cannot access `webServer`
// from a consumer context, and the shared `/api` interceptor is single-owner in
// rc.5. Verified at runtime under the real rc.5 profile loader:
//   - rpc.handle -> "cannot get property webServer without inject"
//   - rpc.intercept('/api', ...) -> "shared RPC channel /api already has an interceptor"
//
// The supported seam is the reviewed `webServer` route registry plus the
// connection service's own admission (`ctx.connection.admit(req)`), carrying the
// frozen client-request/server-response envelope shape. The Host still binds
// the peer/owner and the same authenticated browser session; this module adds
// no trust of its own.
import {LIMITS} from './contracts.mjs';

export const HTTP_RPC_CHANNEL = '/local-workbench';
export const HTTP_RPC_MAX_REQUEST_BYTES = 128 * 1024;
const RPC_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/;

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body, 'utf8'),
  });
  res.end(body);
}

function badRequest(rpcId) {
  return {
    type: 'server-response',
    rpcId,
    result: {ok: false, error: {code: 'gateway/bad-request', message: 'invalid client-request message', details: {issues: []}}},
  };
}

function internalFailure(rpcId) {
  return {
    type: 'server-response',
    rpcId,
    result: {ok: false, error: {code: 'gateway/internal', message: 'internal failure', details: {}}},
  };
}

function validateClientRequest(envelope) {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) return null;
  if (envelope.type !== 'client-request') return null;
  if (typeof envelope.rpcId !== 'string' || !RPC_ID.test(envelope.rpcId)) return null;
  if (typeof envelope.method !== 'string' || !ENDPOINT_SEGMENT.test(envelope.method)) return null;
  return {rpcId: envelope.rpcId, method: envelope.method, payload: envelope.payload};
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  if (typeof req[Symbol.asyncIterator] === 'function') {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) return {ok: false, reason: 'LIMIT_EXCEEDED'};
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  }
  return {ok: true, body: Buffer.concat(chunks).toString('utf8')};
}

/**
 * Register the workbench's POST /local-workbench/<endpoint> carrier on the
 * reviewed webServer route registry.
 *
 * @param {object} ctx Host context; must have `connection.admit` and `webServer.register`.
 * @param {{channel?: string, handler: Function}} options
 * @returns {Function} disposer (also effect-scoped by the caller's fiber).
 */
export function registerWorkbenchHttpRoute(ctx, {channel = HTTP_RPC_CHANNEL, handler} = {}) {
  if (typeof ctx?.connection?.admit !== 'function') throw new Error('local-workbench: connection.admit is unavailable');
  if (typeof ctx?.webServer?.register !== 'function') throw new Error('local-workbench: webServer.register is unavailable');
  const route = {
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      let rpcId = 'invalid-request';
      try {
        if (req.method !== 'POST') {
          res.writeHead(405, {'content-type': 'text/plain; charset=utf-8'});
          res.end('method not allowed');
          return;
        }
        const admission = ctx.connection.admit(req);
        if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
          res.writeHead(admission.rejection);
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
        const peer = admission.peer;
        const pathname = String(req.url ?? '').split('?', 1)[0];
        const prefix = `${channel}/`;
        const endpoint = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
        if (endpoint === '' || !ENDPOINT_SEGMENT.test(endpoint)) {
          jsonResponse(res, 200, badRequest(rpcId));
          return;
        }
        const body = await readBody(req, HTTP_RPC_MAX_REQUEST_BYTES);
        if (!body.ok) {
          jsonResponse(res, 200, badRequest(rpcId));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body.body);
        } catch {
          jsonResponse(res, 200, badRequest(rpcId));
          return;
        }
        rpcId = typeof parsed?.rpcId === 'string' && RPC_ID.test(parsed.rpcId) ? parsed.rpcId : rpcId;
        const envelope = validateClientRequest(parsed);
        if (envelope === null || envelope.method !== endpoint) {
          jsonResponse(res, 200, badRequest(rpcId));
          return;
        }
        const controller = new AbortController();
        if (typeof req.on === 'function') {
          req.on('aborted', () => controller.abort(new Error('client disconnected')));
        }
        let value;
        try {
          value = await handler(envelope.method, envelope.payload, controller.signal, peer);
        } catch {
          jsonResponse(res, 500, internalFailure(envelope.rpcId));
          return;
        }
        let encoded;
        try {
          encoded = JSON.stringify({type: 'server-response', rpcId: envelope.rpcId, result: {ok: true, value}});
        } catch {
          jsonResponse(res, 500, internalFailure(envelope.rpcId));
          return;
        }
        if (Buffer.byteLength(encoded, 'utf8') > LIMITS.max_response_bytes + 64 * 1024) {
          jsonResponse(res, 500, internalFailure(envelope.rpcId));
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(encoded, 'utf8'),
        });
        res.end(encoded);
      } catch {
        // Never leak error text/paths to the client; fixed envelope only.
        try {
          jsonResponse(res, 500, internalFailure(rpcId));
        } catch {
          // response already owned/completed
        }
      }
    },
  };
  return ctx.effect(() => ctx.webServer.register(route), `local-workbench: ${channel} http rpc route`);
}
