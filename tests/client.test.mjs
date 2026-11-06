// T4 / UI-04,05 client-half contract tests.
//
// These tests load the REAL rc.5 client module (bundle/client.js) through the
// fake loader/window/document/require/ctx in tests/helpers/client-harness.mjs.
// They assert the plugin wrapper shape, slot registrations, context discovery,
// status polling/epoch rules, navigation adapter rules (UI-NAV-01), composition
// preview (read-only), fixed transport-failure mapping (UI-RPC-01) and teardown.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  PLUGIN_ID,
  acceptedActionResult,
  createHarness,
  failResponse,
  findNodes,
  makeCatalogRow,
  makeContext,
  makeIntent,
  makeModule,
  makeStatusData,
  okResponse,
  readBundleSource,
  rejectedActionResult,
  textOf,
} from './helpers/client-harness.mjs';

const FUTURE = () => new Date(Date.now() + 30000).toISOString();
const PAST = '2020-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function harnessWith(handler, options = {}) {
  const h = await createHarness(options);
  for (const [endpoint, responder] of Object.entries(handler)) h.api.setResponse(endpoint, responder);
  return h;
}

function readyOptions(overrides = {}) {
  return {
    contexts: [makeContext()],
    catalog: [],
    fixtureMode: false,
    contextsHandler: null,
    statusHandler: null,
    beforeBoot: null,
    ...overrides,
  };
}

async function readyHarness(overrides = {}) {
  const options = readyOptions(overrides);
  const h = await createHarness(options.harnessOptions ?? {});
  h.api.setResponse('context.list', options.contextsHandler ?? ((payload) => okResponse(payload, {
    contexts: options.contexts,
    diagnostics: [],
    fixture_mode: options.fixtureMode === true,
    modules: options.catalog,
  })));
  h.api.setResponse('status.get', options.statusHandler ?? ((payload) => okResponse(payload, makeStatusData(payload, {
    changed: true,
    revision: 3,
    modules: [
      makeModule({module_id: '05', capabilities: ['memory.recall'], updated_at: '2026-11-06T08:05:00.000Z'}),
      makeModule({module_id: '07', capabilities: ['context.observe']}),
    ],
  }))));
  for (const panelKey of overrides.foreignPanels ?? []) h.slots.registerForeign('main', {key: panelKey});
  if (options.beforeBoot) options.beforeBoot(h, options);
  await h.boot();
  return h;
}

function lastStatusPayload(h) {
  return h.api.lastPayload('status.get');
}

function receiptPayloads(h) {
  return h.api.payloadsFor('navigation.receipt');
}

function assertNoRawText(text) {
  assert.equal(text.includes('SECRET_RAW_MESSAGE'), false, 'raw Host error message leaked into the UI');
  assert.equal(text.includes('C:/secret/path'), false, 'raw Host error details leaked into the UI');
}

// ---------------------------------------------------------------------------
// 1. loader wrapper and factory contract
// ---------------------------------------------------------------------------

test('rc.5 loader wrapper: id, first executable statement, only react required, plugin shape', async (t) => {
  const source = readBundleSource();
  assert.ok(source.length < 64 * 1024, `bundle source must stay below 64KB, got ${source.length}`);
  const withoutLeadingComment = source.replace(/^\s*\/\*[\s\S]*?\*\//, '').trimStart();
  assert.ok(
    withoutLeadingComment.startsWith('window.__ModuleLoader__.load({'),
    'first executable statement must be window.__ModuleLoader__.load({...})',
  );

  const h = await createHarness();
  t.after(() => h.dispose());

  assert.equal(h.loadError, null, `bundle failed to execute: ${h.loadError?.message}`);
  assert.equal(h.registrations.length, 1, 'exactly one __ModuleLoader__.load registration is expected');
  assert.equal(h.registration.id, PLUGIN_ID);
  assert.equal(typeof h.registration.factory, 'function');

  assert.equal(h.factoryError, null, `factory threw: ${h.factoryError?.message}`);
  assert.deepEqual(h.requires, ['react'], 'the bundle may only require the static react seed');
  assert.equal(h.plugin.name, 'local-workbench');
  assert.deepEqual(h.plugin.inject, ['slots', 'layout', 'connection']);
  assert.equal(typeof h.plugin.apply, 'function');
});

test('one scoped stylesheet is injected at materialization with a11y/layout rules', async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  assert.equal(h.styleCount(), 1, 'exactly one <style data-local-workbench> must be injected');
  const style = h.styleNode();
  assert.ok(style, 'style element must be appended to document.head');
  assert.equal(style.parentNode, h.document.head);
  assert.ok(style.hasAttribute('data-local-workbench'));
  const css = String(style.textContent);
  for (const needle of [
    'lw-',
    '@media (min-width:640px)',
    'prefers-reduced-motion',
    'overflow-wrap:anywhere',
    'font-size:14px',
    'line-height:1.5',
    ':focus-visible',
  ]) {
    assert.ok(css.includes(needle), `stylesheet must contain ${JSON.stringify(needle)}`);
  }
  h.apply();
  assert.equal(h.styleCount(), 1, 'apply must not inject a second stylesheet');
});

// ---------------------------------------------------------------------------
// 2. slot registrations
// ---------------------------------------------------------------------------

test('registers the keyed main panel and the sidebar panellist entry', async (t) => {
  const h = await createHarness();
  t.after(() => h.dispose());
  h.apply();

  const main = h.mainEntry();
  assert.ok(main, 'main slot key "local-workbench" must be registered');
  assert.equal(main.options.name, 'main');
  assert.equal(main.options.key, 'local-workbench');
  assert.equal(typeof main.component, 'function');

  const panellist = h.panellistEntry();
  assert.ok(panellist, 'sidebar.panellist entry "local-workbench" must be registered');
  assert.equal(panellist.options.name, 'sidebar.panellist');
  assert.equal(panellist.options.id, 'local-workbench');
  assert.equal(panellist.options.order, 30);
  assert.equal(typeof panellist.options.label, 'function');
  assert.equal(panellist.options.label(), '本地工作台');
  assert.equal(typeof panellist.component, 'function', 'panellist component must be a React component');

  // the panellist glyph renders without hooks / needs no context
  const icon = panellist.component({size: 18, active: false});
  assert.equal(icon.type, 'svg', 'panellist icon must be an inline SVG, not an emoji');
});

// ---------------------------------------------------------------------------
// 3. context discovery
// ---------------------------------------------------------------------------

test('zero contexts: blocked view, fixed reason, no polling', async (t) => {
  const h = await harnessWith({
    'context.list': (payload) => okResponse(payload, {contexts: [], diagnostics: [], fixture_mode: false}),
  });
  t.after(() => h.dispose());
  await h.boot();

  const text = h.text();
  assert.ok(text.includes('没有已登记的工作台上下文'), `blocked reason missing: ${text}`);
  assert.equal(h.api.callsFor('context.list').length, 1);

  await h.advance(5000);
  assert.equal(h.api.callsFor('status.get').length, 0, 'no status.get polling is allowed without a context');
  assert.equal(h.timers.pendingIntervals(), 0, 'no polling interval may be left running when blocked');
});

test('discovery request shell uses the reserved bootstrap context_ref and fresh operation ids', async (t) => {
  const h = await readyHarness();
  t.after(() => h.dispose());

  const discovery = h.api.callsFor('context.list')[0];
  assert.equal(discovery.channel, '/local-workbench');
  assert.equal(discovery.payload.schema_version, 1);
  assert.equal(discovery.payload.context_ref, 'bootstrap');
  assert.equal(discovery.payload.expected_scope_generation, 1);
  assert.equal(discovery.payload.view_epoch, 0);
  assert.deepEqual(discovery.payload.input, {});
  assert.equal(typeof discovery.payload.operation_id, 'string');
  assert.ok(discovery.payload.operation_id.length > 0);

  const ids = h.api.calls.map((call) => call.payload.operation_id);
  assert.equal(new Set(ids).size, ids.length, 'operation_id must be unique per request');
});

test('one context is auto-selected; status.get is polled with after_revision and skips re-render when unchanged', async (t) => {
  const statusCalls = [];
  const h = await readyHarness({
    statusHandler: (payload) => {
      statusCalls.push(payload);
      if (statusCalls.length === 1) {
        return okResponse(payload, makeStatusData(payload, {
          changed: true,
          revision: 7,
          modules: [makeModule({module_id: '05'})],
        }));
      }
      return okResponse(payload, makeStatusData(payload, {changed: false, revision: 7, modules: []}));
    },
  });
  t.after(() => h.dispose());

  assert.equal(statusCalls.length, 1, 'status.get should be fetched once right after auto-selection');
  assert.equal(statusCalls[0].input.after_revision, undefined, 'first poll must not send after_revision');
  assert.ok(h.text().includes('本地记忆'), 'module card must render after the first status response');

  await h.advance(1000);
  assert.equal(statusCalls.length, 2);
  assert.equal(statusCalls[1].input.after_revision, 7, 'subsequent polls must send the last seen revision');

  await h.advance(1000);
  assert.equal(statusCalls.length, 3);
  assert.equal(statusCalls[2].input.after_revision, 7, 'unchanged revisions must keep the same after_revision');
  assert.ok(h.text().includes('本地记忆'), 'unchanged response must not clear the module details');
});

test('polling keeps at most one status.get in flight per view', async (t) => {
  const pending = [];
  const h = await readyHarness({
    statusHandler: () => new Promise((resolve) => pending.push(resolve)),
  });
  t.after(() => h.dispose());

  assert.equal(h.api.callsFor('status.get').length, 1);
  await h.advance(4000);
  assert.equal(h.api.callsFor('status.get').length, 1, 'timer ticks must not start a second in-flight status.get');

  const first = h.api.callsFor('status.get')[0];
  pending[0](okResponse(first.payload, makeStatusData(first.payload, {changed: true, revision: 1, modules: [makeModule({module_id: '05'})]})));
  await h.flush();
  assert.ok(h.text().includes('本地记忆'));

  await h.advance(1000);
  assert.equal(h.api.callsFor('status.get').length, 2, 'polling resumes after the in-flight response settles');
});

test('more than one context requires an explicit choice and does not poll before it', async (t) => {
  const contexts = [
    makeContext({context_ref: 'ctx-a', label: '工作区 A'}),
    makeContext({context_ref: 'ctx-b', scope_ref: 'scope-b', label: '工作区 B'}),
  ];
  const h = await readyHarness({
    contexts,
    statusHandler: (payload) => okResponse(payload, makeStatusData(payload, {
      changed: true,
      revision: 1,
      scope_ref: payload.context_ref === 'ctx-b' ? 'scope-b' : 'scope-a',
      modules: [makeModule({module_id: '05'})],
    })),
  });
  t.after(() => h.dispose());

  assert.ok(h.text().includes('检测到多个工作台上下文'), 'multi-context chooser must be visible');
  assert.equal(h.api.callsFor('status.get').length, 0, 'no silent pick: no status.get before the user chooses a context');

  h.click('工作区 B');
  await h.flush();
  assert.equal(h.api.callsFor('status.get').length, 1, 'status.get starts after explicit selection');
  const status = h.api.callsFor('status.get')[0];
  assert.equal(status.payload.context_ref, 'ctx-b');
  assert.equal(status.payload.expected_scope_generation, 1);
});

test('fixture_mode context shows the non-real-capability banner', async (t) => {
  const h = await readyHarness({fixtureMode: true});
  t.after(() => h.dispose());
  assert.ok(h.text().includes('fixture 组合（非真实能力）'), 'fixture banner must be visible when fixture_mode is true');
});

// ---------------------------------------------------------------------------
// 4. view epoch / scope change / visibility
// ---------------------------------------------------------------------------

test('switching context aborts the old in-flight status request and discards its late response', async (t) => {
  const pending = [];
  const h = await readyHarness({
    contexts: [
      makeContext({context_ref: 'ctx-a', label: '工作区 A', selected_module_ids: ['05']}),
      makeContext({context_ref: 'ctx-b', scope_ref: 'scope-b', label: '工作区 B', selected_module_ids: ['07']}),
    ],
    statusHandler: (payload) => new Promise((resolve) => pending.push({payload, resolve})),
  });
  t.after(() => h.dispose());

  h.click('工作区 A');
  await h.flush();
  assert.equal(h.api.callsFor('status.get').length, 1);
  const firstCall = h.api.callsFor('status.get')[0];
  assert.equal(firstCall.signal?.aborted, false);

  h.click('工作区 B');
  await h.flush();
  assert.equal(firstCall.signal?.aborted, true, 'old in-flight request must be aborted on scope change');

  // late response from the old view arrives after the switch: it must be dropped
  pending[0].resolve(okResponse(firstCall.payload, makeStatusData(firstCall.payload, {
    changed: true,
    revision: 99,
    modules: [makeModule({module_id: '05', capabilities: ['late-old-view']})],
  })));
  await h.flush();
  assert.equal(h.text().includes('late-old-view'), false, 'late old-view response must not overwrite the newer view');

  const calls = h.api.callsFor('status.get');
  assert.ok(calls.length >= 2);
  const newest = calls[calls.length - 1];
  assert.equal(newest.payload.context_ref, 'ctx-b');
  assert.ok(newest.payload.view_epoch >= 1, 'view_epoch must be incremented after the scope change');
});

test('scope_generation change in a status response bumps view_epoch, clears details, refreshes context.list and polls the new generation', async (t) => {
  const contexts = [makeContext({scope_generation: 1, context_revision: 'ctx-rev-1'})];
  let statusCount = 0;
  const h = await readyHarness({
    contextsHandler: (payload) => okResponse(payload, {
      contexts: contexts.map((context) => ({...context})),
      diagnostics: [],
      fixture_mode: false,
    }),
    statusHandler: (payload) => {
      statusCount += 1;
      if (statusCount === 1) {
        return okResponse(payload, makeStatusData(payload, {
          changed: true,
          revision: 4,
          modules: [makeModule({module_id: '05', capabilities: ['gen-one']})],
        }));
      }
      if (statusCount === 2) {
        // The Host reports a new scope generation for the same context_ref.
        contexts[0] = makeContext({scope_generation: 2, context_revision: 'ctx-rev-2'});
        return okResponse(payload, makeStatusData(payload, {
          changed: true,
          revision: 5,
          scope_generation: 2,
          context_revision: 'ctx-rev-2',
          modules: [makeModule({module_id: '05', capabilities: ['gen-two'], generation: 2})],
        }));
      }
      return okResponse(payload, makeStatusData(payload, {
        changed: true,
        revision: 5,
        scope_generation: 2,
        context_revision: 'ctx-rev-2',
        modules: [makeModule({module_id: '05', capabilities: ['gen-two'], generation: 2})],
      }));
    },
  });
  t.after(() => h.dispose());

  assert.ok(h.text().includes('本地记忆'));
  await h.advance(1000);
  await h.flush();

  assert.ok(h.api.callsFor('context.list').length >= 2, 'context.list must be refreshed after a scope change');
  const refreshed = h.api.callsFor('context.list')[h.api.callsFor('context.list').length - 1];
  assert.ok(refreshed.payload.view_epoch >= 1, 'refreshed context.list must carry the bumped view_epoch');

  const statusCalls = h.api.callsFor('status.get');
  const postChange = statusCalls[statusCalls.length - 1];
  assert.equal(postChange.payload.expected_scope_generation, 2, 'polling must move to the new scope generation');
  assert.ok(postChange.payload.view_epoch >= 1, 'post-change requests must carry the bumped view_epoch');
  assert.ok(h.text().includes('本地记忆'));
});

test('hidden document stops polling and aborts the in-flight request; visible resumes it', async (t) => {
  const pending = [];
  const h = await readyHarness({
    statusHandler: (payload) => new Promise((resolve) => pending.push({payload, resolve})),
  });
  t.after(() => h.dispose());

  await h.advance(1000);
  const inFlight = h.api.callsFor('status.get')[0];
  assert.equal(inFlight.signal?.aborted, false);

  h.setVisibility('hidden');
  await h.flush();
  assert.equal(inFlight.signal?.aborted, true, 'hiding the document must abort the in-flight status request');

  const callsWhileHidden = h.api.callsFor('status.get').length;
  await h.advance(5000);
  assert.equal(h.api.callsFor('status.get').length, callsWhileHidden, 'no status.get may be issued while hidden');

  h.setVisibility('visible');
  await h.flush();
  assert.equal(h.api.callsFor('status.get').length, callsWhileHidden + 1, 'becoming visible must poll immediately again');
});

// ---------------------------------------------------------------------------
// 5. teardown
// ---------------------------------------------------------------------------

test('unmount clears the interval, aborts in flight, removes the visibility listener and sends nothing more', async (t) => {
  let statusCalls = 0;
  const h = await readyHarness({
    statusHandler: (payload) => {
      statusCalls += 1;
      if (statusCalls === 1) {
        return okResponse(payload, makeStatusData(payload, {changed: true, revision: 1, modules: [makeModule({module_id: '05'})]}));
      }
      return new Promise(() => {});
    },
  });
  t.after(() => h.dispose());
  await h.advance(1000);

  const callCount = h.api.callsFor('status.get').length;
  const inFlight = h.api.callsFor('status.get')[callCount - 1];
  assert.equal(inFlight.signal?.aborted, false, 'the second status request must be genuinely in flight');

  h.unmountPanel();
  assert.equal(h.timers.pendingIntervals(), 0, 'polling interval must be cleared on panel unmount');
  assert.equal(h.visibilityListenerCount(), 0, 'visibilitychange listener must be removed on panel unmount');
  assert.equal(inFlight.signal?.aborted, true, 'in-flight status request must be aborted on unmount');

  await h.advance(10000);
  assert.equal(h.api.callsFor('status.get').length, callCount, 'no status.get may be issued after unmount');
});

test('apply disposer removes slot registrations, scoped style and listeners', async (t) => {
  const h = await readyHarness();
  t.after(() => h.dispose());

  h.unmountPanel();
  h.ctx.dispose();
  assert.equal(h.mainEntry(), null, 'main slot registration must be disposed with the plugin effect');
  assert.equal(h.panellistEntry(), null, 'panellist slot registration must be disposed with the plugin effect');
  assert.equal(h.styleCount(), 0, 'the scoped stylesheet must be removed by the apply disposer');
  assert.equal(h.visibilityListenerCount(), 0);
  assert.equal(h.timers.pendingCount(), 0);
});

test('return to chat selects the conversation panel without any business claim', async (t) => {
  const h = await readyHarness();
  t.after(() => h.dispose());

  h.api.reset();
  h.click('返回聊天');
  await h.flush();
  assert.deepEqual(h.layout.selection.at(-1), null);
  assert.deepEqual(h.api.endpoints(), [], 'returning to chat must not send any business RPC');
});

// ---------------------------------------------------------------------------
// 6. navigation adapter (UI-NAV-01)
// ---------------------------------------------------------------------------

test('valid panel intent selects the target panel exactly once and records an opened receipt', async (t) => {
  const intent = makeIntent({intent_id: 'intent-panel-1', target: {kind: 'panel', panel_key: 'local-memory'}});
  const h = await readyHarness({
    foreignPanels: ['local-memory'],
    beforeBoot: (harness) => {
      harness.api.setResponse('navigation.prepare', (payload) => okResponse(payload, acceptedActionResult(payload, intent, {owner_module: '05'})));
    },
  });
  t.after(() => h.dispose());

  h.click('进入本地记忆');
  await h.flush();

  assert.equal(h.layout.selection.filter((entry) => entry === 'local-memory').length, 1);
  const receipts = receiptPayloads(h);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].context_ref, 'ctx-a');
  assert.equal(receipts[0].input.intent_id, 'intent-panel-1');
  assert.equal(receipts[0].input.client_state, 'opened');
  assert.ok(h.text().includes('已打开'), `opened notice missing: ${h.text()}`);
});

test('duplicate intent_id is deduped and never navigates twice', async (t) => {
  const intent = makeIntent({intent_id: 'intent-dup', target: {kind: 'panel', panel_key: 'local-memory'}});
  const h = await readyHarness({
    foreignPanels: ['local-memory'],
    beforeBoot: (harness) => {
      harness.api.setResponse('navigation.prepare', (payload) => okResponse(payload, acceptedActionResult(payload, intent)));
    },
  });
  t.after(() => h.dispose());

  h.click('进入本地记忆');
  await h.flush();
  h.click('进入本地记忆');
  await h.flush();
  h.click('进入本地记忆');
  await h.flush();

  assert.equal(h.api.callsFor('navigation.prepare').length, 3);
  assert.equal(h.layout.selection.filter((entry) => entry === 'local-memory').length, 1, 'a repeated intent_id must not navigate again');
  assert.equal(receiptPayloads(h).length, 1, 'a duplicate intent must not record a second receipt');
});

test('expired intent is stale: no selectPanel, stale receipt with EXPIRED_INTENT', async (t) => {
  const intent = makeIntent({intent_id: 'intent-expired', expires_at: PAST, target: {kind: 'panel', panel_key: 'local-memory'}});
  const h = await readyHarness({
    foreignPanels: ['local-memory'],
    beforeBoot: (harness) => {
      harness.api.setResponse('navigation.prepare', (payload) => okResponse(payload, acceptedActionResult(payload, intent)));
    },
  });
  t.after(() => h.dispose());

  h.click('进入本地记忆');
  await h.flush();

  assert.equal(h.layout.selection.filter((entry) => entry === 'local-memory').length, 0);
  const receipts = receiptPayloads(h);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].input.client_state, 'stale');
  assert.equal(receipts[0].input.reason_code, 'EXPIRED_INTENT');
  assert.ok(h.text().includes('过期'), `stale explanation missing: ${h.text()}`);
});

test('intent bound to another scope/generation/context_revision is stale and never navigates', async (t) => {
  const variants = [
    {overrides: {scope_ref: 'scope-other'}, reason: 'STALE_SCOPE'},
    {overrides: {scope_generation: 9}, reason: 'STALE_SCOPE'},
    {overrides: {context_revision: 'ctx-rev-other'}, reason: 'STALE_REVISION'},
  ];
  for (const variant of variants) {
    const intent = makeIntent({intent_id: `intent-stale-${variant.reason}`, target: {kind: 'panel', panel_key: 'local-memory'}, ...variant.overrides});
    const h = await readyHarness({
      foreignPanels: ['local-memory'],
      beforeBoot: (harness) => {
        harness.api.setResponse('navigation.prepare', (payload) => okResponse(payload, acceptedActionResult(payload, intent)));
      },
    });
    try {
      h.click('进入本地记忆');
      await h.flush();
      assert.equal(h.layout.selection.filter((entry) => entry === 'local-memory').length, 0, `variant ${variant.reason} must not navigate`);
      const receipts = receiptPayloads(h);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].input.client_state, 'stale');
      assert.equal(receipts[0].input.reason_code, variant.reason);
    } finally {
      h.dispose();
    }
  }
});

test('skill intent renders a visible instruction card, records instruction_shown and never navigates', async (t) => {
  const intent = makeIntent({
    intent_id: 'intent-skill',
    target: {kind: 'skill', skill_ref: 'memory.recall', instruction_key: 'memory.recall'},
  });
  const clipboardWrites = [];
  const h = await readyHarness({
    harnessOptions: {
      navigator: {clipboard: {writeText: async (text) => { clipboardWrites.push(text); }}},
    },
    beforeBoot: (harness) => {
      harness.api.setResponse('navigation.prepare', (payload) => okResponse(payload, acceptedActionResult(payload, intent)));
    },
  });
  t.after(() => h.dispose());

  h.click('进入本地记忆');
  await h.flush();

  assert.equal(h.layout.selection.length, 0, 'skill intents must never call layout.selectPanel');
  const receipts = receiptPayloads(h);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].input.client_state, 'instruction_shown');
  const text = h.text();
  assert.ok(text.includes('手动打开说明'), `instruction card missing: ${text}`);
  assert.ok(text.includes('memory.recall'), 'instruction_key text must be visible');
  assert.ok(text.includes('复制指令'), 'copy button must be visible');

  h.click('复制指令');
  await h.flush();
  assert.equal(clipboardWrites.length, 1, 'copy must use navigator.clipboard.writeText');
  assert.ok(clipboardWrites[0].includes('memory.recall'), 'the copied text must contain the registered instruction');
  assert.ok(h.text().includes('已复制'), 'copy success feedback must be visible');
});

test('host_command intent also renders the instruction card without executing anything', async (t) => {
  const intent = makeIntent({
    intent_id: 'intent-command',
    owner_module: '07',
    target: {kind: 'host_command', command_ref: 'context.observe', instruction_key: 'context.observe'},
  });
  const h = await readyHarness({
    beforeBoot: (harness) => {
      harness.api.setResponse('navigation.prepare', (payload) => okResponse(payload, acceptedActionResult(payload, intent, {owner_module: '07'})));
    },
  });
  t.after(() => h.dispose());

  h.click('进入上下文观察');
  await h.flush();

  assert.equal(h.layout.selection.length, 0);
  assert.equal(receiptPayloads(h)[0].input.client_state, 'instruction_shown');
  assert.ok(h.text().includes('context.observe'));
});

test('selectPanel throwing becomes a local unavailable state plus TARGET_UNREGISTERED receipt', async (t) => {
  const intent = makeIntent({intent_id: 'intent-unregistered', target: {kind: 'panel', panel_key: 'local-unregistered'}});
  const h = await readyHarness({
    beforeBoot: (harness) => {
      harness.api.setResponse('navigation.prepare', (payload) => okResponse(payload, acceptedActionResult(payload, intent)));
    },
  });
  t.after(() => h.dispose());

  h.click('进入本地记忆');
  await h.flush();

  const receipts = receiptPayloads(h);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].input.client_state, 'unavailable');
  assert.equal(receipts[0].input.reason_code, 'TARGET_UNREGISTERED');
  assert.ok(h.text().includes('尚未注册'), `unavailable explanation missing: ${h.text()}`);
});

test('Host business rejection of navigation.prepare is explained, not navigated', async (t) => {
  const h = await readyHarness({
    foreignPanels: ['local-memory'],
    beforeBoot: (harness) => {
      harness.api.setResponse('navigation.prepare', (payload) => okResponse(payload, rejectedActionResult(payload, 'denied', 'MODULE_DENIED')));
    },
  });
  t.after(() => h.dispose());

  h.click('进入本地记忆');
  await h.flush();
  assert.equal(h.layout.selection.length, 0);
  assert.equal(receiptPayloads(h).length, 0, 'no receipt without a trusted intent');
  assert.ok(h.text().length > 0);
});

// ---------------------------------------------------------------------------
// 7. card rendering rules
// ---------------------------------------------------------------------------

test('cards show state text, local reason explanation, localized time and disabled entry for non-ready modules', async (t) => {
  const h = await readyHarness({
    statusHandler: (payload) => okResponse(payload, makeStatusData(payload, {
      changed: true,
      revision: 2,
      modules: [
        makeModule({module_id: '05', state: 'ready', updated_at: '2026-11-06T08:05:00.000Z'}),
        makeModule({module_id: '07', state: 'busy', reason_code: 'MODULE_BUSY', active_operations: [{operation_id: 'op-running-1', kind: 'observe', state: 'running'}]}),
      ],
    })),
  });
  t.after(() => h.dispose());

  const text = h.text();
  for (const needle of ['本地记忆', '上下文观察', '可用', '忙碌', '模块正在处理其他操作', '更新于', '进行中']) {
    assert.ok(text.includes(needle), `card text missing ${JSON.stringify(needle)}: ${text}`);
  }
  const entry = h.button('进入上下文观察');
  assert.ok(entry, 'non-ready module entry should still be visible');
  assert.equal(entry.disabled, true, 'entry for a busy module must be disabled');
});

test('attention/blocked modules, outcome_unknown operations and error diagnostics appear in the needs-attention section', async (t) => {
  const h = await readyHarness({
    statusHandler: (payload) => okResponse(payload, makeStatusData(payload, {
      changed: true,
      revision: 3,
      diagnostics: [
        {code: 'MEMORY_DB_LOCKED', severity: 'error', module_ids: ['05'], resource_ref: 'memory.db', message_key: 'memory.db.locked'},
        {code: 'CONTEXT_STALE', severity: 'warning', module_ids: ['07'], resource_ref: null, message_key: 'context.stale'},
      ],
      modules: [
        makeModule({module_id: '05', state: 'attention', reason_code: 'NOT_READY'}),
        makeModule({module_id: '07', state: 'blocked', reason_code: 'DEPENDENCY_MISSING'}),
      ],
    })),
  });
  t.after(() => h.dispose());

  const text = h.text();
  assert.ok(text.includes('需处理'), 'needs-attention section must be visible');
  assert.ok(text.includes('需处理') && text.includes('阻断'), 'attention/blocked states must be listed');
  assert.ok(!text.includes('MEMORY_DB_LOCKED'), 'raw diagnostic code must not be the displayed explanation');
});

test('outcome_unknown operations are shown as 结果待核实, distinct from failed/queued', async (t) => {
  const h = await readyHarness({
    statusHandler: (payload) => okResponse(payload, makeStatusData(payload, {
      changed: true,
      revision: 3,
      modules: [makeModule({
        module_id: '05',
        state: 'attention',
        active_operations: [
          {operation_id: 'op-unknown', kind: 'recall', state: 'outcome_unknown'},
          {operation_id: 'op-queued', kind: 'write', state: 'queued'},
        ],
      })],
    })),
  });
  t.after(() => h.dispose());

  const text = h.text();
  assert.ok(text.includes('结果待核实'), `outcome_unknown text missing: ${text}`);
  assert.ok(text.includes('排队中'), 'queued operations must keep their own text');
});

test('known-but-unselected modules are listed read-only under 后续接入', async (t) => {
  const h = await readyHarness({
    contexts: [makeContext({selected_module_ids: ['05'], allowed_module_ids: ['05', '07']})],
    statusHandler: (payload) => okResponse(payload, makeStatusData(payload, {
      changed: true,
      revision: 1,
      modules: [makeModule({module_id: '05'})],
    })),
  });
  t.after(() => h.dispose());

  const text = h.text();
  assert.ok(text.includes('后续接入'), 'later-integration list must be visible');
  assert.ok(text.includes('尚未接入'), 'unselected known modules must be marked as not integrated');
  assert.ok(text.includes('上下文观察'), 'the fixed local label for 07 must be used');
  const laterButtons = findNodes(h.tree(), (node) => node.tag === 'button' && textOf(node).includes('上下文观察'));
  assert.equal(laterButtons.length, 0, 'no executable fake button may be rendered for not-yet-integrated modules');
});

// ---------------------------------------------------------------------------
// 7b. owner release version from the context.list catalog summary (T4 follow-up)
// ---------------------------------------------------------------------------

test('cards show the owner release version from the context.list catalog summary', async (t) => {
  const h = await readyHarness({
    catalog: [makeCatalogRow({module_id: '05', name: 'Local Memory', release_version: '0.0.0-fixture', fixture: true})],
    statusHandler: (payload) => okResponse(payload, makeStatusData(payload, {
      changed: true,
      revision: 1,
      modules: [makeModule({module_id: '05'})],
    })),
  });
  t.after(() => h.dispose());

  const card = findNodes(h.tree(), (node) => node.tag === 'article' && node.props?.['data-module-id'] === '05')[0];
  assert.ok(card, 'module 05 card must render');
  const cardText = textOf(card);
  assert.ok(cardText.includes('0.0.0-fixture'), `card must show the owner release version: ${cardText}`);
  assert.ok(cardText.includes('Local Memory'), `card must use the catalog name: ${cardText}`);
  assert.ok(cardText.includes('(fixture)'), `card must mark fixture catalog rows: ${cardText}`);
  assert.ok(h.button('进入Local Memory'), 'the entry button uses the catalog display name');
  assert.equal(h.text().includes('无法识别'), false, 'a valid catalog summary must not cause a protocol failure');
});

test('malformed context.list catalog rows are ignored and the remaining rows still render', async (t) => {
  const malformed = [
    {module_id: '99', name: 'Bogus Id', release_version: '1.0.0', entry_kind: 'panel', fixture: true},
    {module_id: '07', name: '', release_version: '1.0.0', entry_kind: 'panel', fixture: true},
    {module_id: '06', name: 'Bogus Kind', release_version: '1.0.0', entry_kind: 'bogus', fixture: true},
    {module_id: '03', name: 'Bogus Fixture', release_version: '1.0.0', entry_kind: 'panel', fixture: 'yes'},
    {module_id: '02', name: 'Missing Fields'},
    null,
    'not-a-row',
  ];
  const h = await readyHarness({
    catalog: [makeCatalogRow({module_id: '05', name: 'Local Memory', release_version: '0.0.0-fixture'}), ...malformed],
    statusHandler: (payload) => okResponse(payload, makeStatusData(payload, {
      changed: true,
      revision: 1,
      modules: [makeModule({module_id: '05'})],
    })),
  });
  t.after(() => h.dispose());

  const text = h.text();
  assert.ok(text.includes('0.0.0-fixture'), 'the valid catalog row must still render');
  for (const leaked of ['Bogus Id', 'Bogus Kind', 'Bogus Fixture', 'Missing Fields', 'not-a-row']) {
    assert.equal(text.includes(leaked), false, `malformed catalog row leaked into the UI: ${leaked}`);
  }
  assert.equal(text.includes('无法识别'), false, 'one malformed row must not fail the whole context.list response');
});

test('cards fall back to the fixed label map when the catalog row is missing', async (t) => {
  const h = await readyHarness({
    catalog: [makeCatalogRow({module_id: '07', name: 'Context Observe', release_version: '0.2.0-fixture'})],
    statusHandler: (payload) => okResponse(payload, makeStatusData(payload, {
      changed: true,
      revision: 1,
      modules: [makeModule({module_id: '05'}), makeModule({module_id: '07'})],
    })),
  });
  t.after(() => h.dispose());

  const card05 = findNodes(h.tree(), (node) => node.tag === 'article' && node.props?.['data-module-id'] === '05')[0];
  const card07 = findNodes(h.tree(), (node) => node.tag === 'article' && node.props?.['data-module-id'] === '07')[0];
  assert.ok(card05 && card07);
  assert.ok(textOf(card05).includes('本地记忆'), 'missing catalog row must fall back to the fixed label map');
  assert.equal(textOf(card05).includes('0.2.0-fixture'), false, 'missing catalog row must not borrow another row version');
  assert.ok(textOf(card07).includes('Context Observe'));
  assert.ok(textOf(card07).includes('0.2.0-fixture'));
});

test('后续接入 uses catalog summary names and versions when available, still read-only', async (t) => {
  const h = await readyHarness({
    contexts: [makeContext({selected_module_ids: ['05'], allowed_module_ids: ['05', '07']})],
    catalog: [
      makeCatalogRow({module_id: '05', name: 'Local Memory', release_version: '0.0.0-fixture'}),
      makeCatalogRow({module_id: '07', name: 'Context Observe', release_version: '0.2.0-fixture', entry_kind: 'skill'}),
    ],
    statusHandler: (payload) => okResponse(payload, makeStatusData(payload, {
      changed: true,
      revision: 1,
      modules: [makeModule({module_id: '05'})],
    })),
  });
  t.after(() => h.dispose());

  const text = h.text();
  assert.ok(text.includes('后续接入'));
  assert.ok(text.includes('Context Observe'), `catalog name must be used in 后续接入: ${text}`);
  assert.ok(text.includes('0.2.0-fixture'), 'catalog release version must be used in 后续接入');
  const laterButtons = findNodes(h.tree(), (node) => node.tag === 'button' && textOf(node).includes('Context Observe'));
  assert.equal(laterButtons.length, 0, 'not-yet-integrated catalog rows stay read-only (no fake buttons)');
});

// ---------------------------------------------------------------------------
// 8. transport / protocol failure mapping (UI-RPC-01)
// ---------------------------------------------------------------------------

test('RpcResult {ok:false} maps to the fixed TRANSPORT_FAILURE text and never leaks Host message/details', async (t) => {
  let statusCalls = 0;
  const h = await readyHarness({
    statusHandler: () => {
      statusCalls += 1;
      return {ok: false, error: {code: 'INTERNAL_ERROR', message: 'SECRET_RAW_MESSAGE', details: {path: 'C:/secret/path'}}};
    },
  });
  t.after(() => h.dispose());

  assert.ok(statusCalls >= 1);
  const text = h.text();
  assert.ok(text.includes('无法连接 Host'), `fixed transport-failure text missing: ${text}`);
  assertNoRawText(text);
});

test('transport exceptions are mapped to the fixed transport-failure text too', async (t) => {
  const h = await readyHarness({
    statusHandler: () => {
      throw new Error('SECRET_RAW_MESSAGE C:/secret/path');
    },
  });
  t.after(() => h.dispose());
  const text = h.text();
  assert.ok(text.includes('无法连接 Host'));
  assertNoRawText(text);
});

// ---------------------------------------------------------------------------
// 9. composition preview is read-only
// ---------------------------------------------------------------------------

test('composition check requests composition.preview with expected_revision/selected_ids, renders the diff and never calls apply', async (t) => {
  const previewData = {
    preview_id: 'preview-1',
    diff: {
      added: ['06'],
      removed: [],
      changed: [{id: '05', before: '1.0.0', after: '1.1.0'}],
      unchanged: ['07'],
    },
    composition_digest: 'b'.repeat(64),
    expires_at: FUTURE(),
  };
  const h = await readyHarness({
    beforeBoot: (harness) => {
      harness.api.setResponse('composition.preview', (payload) => okResponse(payload, previewData));
    },
  });
  t.after(() => h.dispose());

  h.click('检查组合');
  await h.flush();
  assert.ok(h.text().includes('组合诊断'), 'composition section must open');

  const checkboxes = h.checkboxes();
  assert.ok(checkboxes.length >= 2, 'known modules must be exposed as local checkboxes');
  const memoryCheckbox = h.checkboxes().find((box) => box.label.includes('05'));
  assert.ok(memoryCheckbox, 'checkbox for module 05 must exist');
  memoryCheckbox.onChange({target: {checked: false}});
  await h.flush();

  const previews = h.api.payloadsFor('composition.preview');
  assert.equal(previews.length, 1, 'changing a checkbox must request exactly one preview');
  assert.equal(previews[0].input.profile_ref, 'profile-a');
  assert.equal(previews[0].input.expected_revision, 1);
  assert.deepEqual(previews[0].input.selected_ids, ['07']);

  const text = h.text();
  assert.ok(text.includes('新增'), 'diff added rows must be rendered');
  assert.ok(text.includes('06'), 'added module id must be visible');
  assert.ok(text.includes('变更') || text.includes('changed'), 'diff changed rows must be rendered');
  assert.ok(text.includes('Host 管理入口'), 'the read-only note about applying must be visible');
  assert.ok(h.api.endpoints().includes('composition.preview'));
  assert.equal(h.api.endpoints().includes('composition.apply'), false, 'the client must never call composition.apply');
});

test('composition.preview business failure shows a local explanation and never applies', async (t) => {
  const h = await readyHarness({
    beforeBoot: (harness) => {
      harness.api.setResponse('composition.preview', (payload) => failResponse(payload, 'stale', 'STALE_PREVIEW'));
    },
  });
  t.after(() => h.dispose());

  h.click('检查组合');
  await h.flush();
  const memoryCheckbox = h.checkboxes().find((box) => box.label.includes('05'));
  memoryCheckbox.onChange({target: {checked: false}});
  await h.flush();
  assert.ok(h.text().includes('已过期'), `stale preview explanation missing: ${h.text()}`);
  assert.equal(h.api.endpoints().includes('composition.apply'), false);
});

// ---------------------------------------------------------------------------
// 10. accessibility basics
// ---------------------------------------------------------------------------

test('live region, native buttons and focusable error summary are present', async (t) => {
  const h = await readyHarness();
  t.after(() => h.dispose());

  const status = findNodes(h.tree(), (node) => node.props?.role === 'status');
  assert.ok(status.length >= 1, 'a role="status" polite live region must exist');
  assert.equal(status[0].props['aria-live'], 'polite');

  const buttons = h.buttons();
  assert.ok(buttons.length >= 1);
  for (const button of buttons) {
    assert.equal(button.type, 'button', 'all buttons must be native button elements with type=button');
  }

  // trigger the fixed transport failure and check the alert/focus behaviour
  h.api.setResponse('status.get', () => ({ok: false, error: {code: 'X', message: 'SECRET_RAW_MESSAGE', details: {path: 'C:/secret/path'}}}));
  await h.advance(1000);
  const alerts = findNodes(h.tree(), (node) => node.props?.role === 'alert');
  assert.ok(alerts.length >= 1, 'failures must be announced in a role="alert" region');
  const summaries = findNodes(h.tree(), (node) => node.props?.tabIndex === -1);
  assert.ok(summaries.length >= 1, 'an error summary must be focusable (tabIndex -1)');
});
