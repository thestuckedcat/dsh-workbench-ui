// UI-RPC-01 carrier: envelope validation, admission, sanitization and limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerWorkbenchHttpRoute} from '../src/http-rpc.mjs';
import {
  createFakeCtx,
  createFakeHttpRequest,
  createFakeHttpResponse,
  createRecordingConnection,
  invokeHttpRoute,
  ownerPeer,
  rpcRequest,
} from './helpers/host-fixtures.mjs';

function setup({peer = ownerPeer(), handler} = {}) {
  const host = createRecordingConnection({peer});
  const ctx = createFakeCtx({connection: host.connection, webServer: host.webServer});
  const handled = [];
  const routeHandler = handler ?? (async (endpoint, payload, signal, caller) => {
    handled.push({endpoint, payload, hasSignal: signal instanceof AbortSignal, caller});
    return {schema_version: 1, operation_id: payload.operation_id, view_epoch: payload.view_epoch, scope_generation: 1, status: 'ok', data: {endpoint}};
  });
  const dispose = registerWorkbenchHttpRoute(ctx, {handler: routeHandler});
  return {host, ctx, dispose, route: host.routes.get('/local-workbench'), handled};
}

test('carrier registers one prefix route and returns the frozen server-response envelope', async () => {
  const {host, route, handled} = setup();
  assert.ok(route);
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, '/local-workbench');
  assert.equal(host.routes.size, 1);
  const result = await invokeHttpRoute(route, {endpoint: 'status.get', payload: rpcRequest(null, {})});
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'ok');
  assert.equal(result.value.data.endpoint, 'status.get');
  assert.equal(handled.length, 1);
  assert.equal(handled[0].hasSignal, true);
  assert.equal(handled[0].caller.principal.kind, 'owner');
});

test('carrier rejects non-POST, malformed bodies and invalid envelopes with fixed responses', async () => {
  const {route} = setup();
  const getRequest = createFakeHttpRequest({});
  getRequest.method = 'GET';
  const getResponse = createFakeHttpResponse();
  await route.handler(getRequest, getResponse);
  assert.equal(getResponse.statusCode, 405);

  const malformed = createFakeHttpRequest({});
  malformed[Symbol.asyncIterator] = async function* iterator() {
    yield Buffer.from('{not json', 'utf8');
  };
  const malformedResponse = createFakeHttpResponse();
  await route.handler(malformed, malformedResponse);
  assert.equal(malformedResponse.statusCode, 200);
  const malformedBody = JSON.parse(malformedResponse.body);
  assert.equal(malformedBody.type, 'server-response');
  assert.equal(malformedBody.result.ok, false);
  assert.equal(malformedBody.result.error.code, 'gateway/bad-request');

  const wrongMethod = createFakeHttpRequest({endpoint: 'status.get'});
  wrongMethod.url = '/local-workbench/other.endpoint';
  const wrongResponse = createFakeHttpResponse();
  await route.handler(wrongMethod, wrongResponse);
  assert.equal(JSON.parse(wrongResponse.body).result.ok, false);

  const wrongType = createFakeHttpRequest({});
  wrongType[Symbol.asyncIterator] = async function* iterator() {
    yield Buffer.from(JSON.stringify({type: 'server-response', rpcId: 'x', method: 'status.get'}), 'utf8');
  };
  const wrongTypeResponse = createFakeHttpResponse();
  await route.handler(wrongType, wrongTypeResponse);
  assert.equal(JSON.parse(wrongTypeResponse.body).result.ok, false);
});

test('carrier enforces the bounded request body', async () => {
  const {route, handled} = setup();
  const big = createFakeHttpRequest({});
  big[Symbol.asyncIterator] = async function* iterator() {
    yield Buffer.alloc(200 * 1024, 0x20);
  };
  const response = createFakeHttpResponse();
  await route.handler(big, response);
  assert.equal(JSON.parse(response.body).result.ok, false);
  assert.equal(handled.length, 0);
});

test('carrier maps handler throws to a fixed internal failure without leaking error text', async () => {
  const {route} = setup({
    handler: async () => {
      throw new Error('C:\\Users\\admin\\.dsh\\.credentials.yaml token=sk-live');
    },
  });
  const result = await invokeHttpRoute(route, {endpoint: 'status.get', payload: rpcRequest(null, {})});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'gateway/internal');
  assert.equal(result.error.message, 'internal failure');
  assert.equal(JSON.stringify(result).includes('credentials'), false);
});

test('carrier writes admission rejections before parsing the body', async () => {
  const host = createRecordingConnection();
  host.connection.admit = () => ({rejection: 401});
  const ctx = createFakeCtx({connection: host.connection, webServer: host.webServer});
  registerWorkbenchHttpRoute(ctx, {handler: async () => ({})});
  const route = host.routes.get('/local-workbench');
  const request = createFakeHttpRequest({});
  const response = createFakeHttpResponse();
  await route.handler(request, response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body, 'unauthorized');
});

test('carrier requires the reviewed Host services and disposes the route', () => {
  assert.throws(() => registerWorkbenchHttpRoute({webServer: {register() {}}}, {handler: async () => ({})}));
  assert.throws(() => registerWorkbenchHttpRoute({connection: {admit() {}}}, {handler: async () => ({})}));
  const {host, ctx, dispose} = setup();
  assert.equal(host.routes.size, 1);
  dispose();
  assert.equal(host.routes.size, 0);
  return ctx.disposeAll();
});
