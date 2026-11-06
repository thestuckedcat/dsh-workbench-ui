// Fake DeepSeek Harness 0.2.1-rc.5 client-module environment for the 08
// workbench client tests.
//
// The REAL bundle (bundle/client.js) is read from disk and executed unmodified
// with vm.runInThisContext, so the tests exercise the same `window.__ModuleLoader__.load`
// wrapper the pinned Harness loader consumes. Everything fake lives here:
// window/document/timers/require(ctx)/React stub. The bundle may only require
// 'react'; every other id throws.
//
// The React stub is a deliberately tiny function-component renderer with
// useState/useEffect/useRef/useMemo/useCallback. It is good enough for the real
// panel component but is not a general React implementation (no context,
// reducers, suspense or DOM diffing).
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, '..', '..');
export const BUNDLE_FILE = resolve(PROJECT_ROOT, 'bundle', 'client.js');
export const PLUGIN_ID = '@local/dsh-workbench-ui';

// ---------------------------------------------------------------------------
// Fake DOM nodes / document
// ---------------------------------------------------------------------------

export class FakeNode {
  constructor(tagName, ownerDocument = null) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeName = this.tagName;
    this.ownerDocument = ownerDocument;
    this.attributes = Object.create(null);
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.textContent = '';
    this.className = '';
    this.id = '';
    this.style = {};
    this.dataset = {};
    this.disabled = false;
    this.checked = false;
    this.type = undefined;
    this.value = '';
    this.listeners = new Map();
    this.__focused = false;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'id') this.id = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  appendChild(child) {
    if (child === null || child === undefined) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  replaceChildren(...nodes) {
    for (const child of this.children.slice()) this.removeChild(child);
    for (const node of nodes) this.appendChild(node);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    const set = this.listeners.get(type);
    if (set) set.delete(listener);
  }

  dispatchEvent(event) {
    for (const listener of [...(this.listeners.get(event?.type) ?? [])]) listener(event);
  }

  focus() {
    this.__focused = true;
    if (this.ownerDocument) {
      this.ownerDocument.activeElement = this;
      this.ownerDocument.focusLog.push(this);
    }
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains?.(node) === true);
  }

  querySelector(selector) {
    const match = (node) => selectorMatches(node, selector);
    const walk = (node) => {
      for (const child of node.children) {
        if (match(child)) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (selectorMatches(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

function selectorMatches(node, selector) {
  const trimmed = String(selector).trim();
  // Only the tiny selector subset the workbench may use: tag, [attr], tag[attr].
  const match = /^([a-zA-Z][\w-]*)?(?:\[([a-zA-Z][\w-]*)(?:=["']?([^"'\]]*)["']?)?\])?$/.exec(trimmed);
  if (!match) return false;
  const [, tag, attribute, value] = match;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (attribute && !node.hasAttribute(attribute)) return false;
  if (attribute && value !== undefined && node.getAttribute(attribute) !== value) return false;
  return true;
}

export function createDocument() {
  const documentElement = new FakeNode('html');
  const head = new FakeNode('head');
  const body = new FakeNode('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);
  const documentListeners = new Map();
  const doc = {
    documentElement,
    head,
    body,
    visibilityState: 'visible',
    activeElement: null,
    focusLog: [],
    createElement(tagName) {
      return new FakeNode(tagName, doc);
    },
    querySelector(selector) {
      if (typeof selector === 'string' && selector.startsWith('#')) {
        const id = selector.slice(1);
        const found = documentElement.querySelectorAll('*').find((node) => node.id === id);
        return found ?? null;
      }
      return documentElement.querySelector(selector);
    },
    querySelectorAll(selector) {
      return documentElement.querySelectorAll(selector);
    },
    getElementById(id) {
      return doc.querySelector(`#${id}`);
    },
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      const set = documentListeners.get(type);
      if (set) set.delete(listener);
    },
    listenerCount(type) {
      return documentListeners.get(type)?.size ?? 0;
    },
    listenerTypes() {
      return [...documentListeners.keys()];
    },
    __setVisibility(state) {
      doc.visibilityState = state;
      for (const listener of [...(documentListeners.get('visibilitychange') ?? [])]) listener({type: 'visibilitychange'});
    },
  };
  return doc;
}

// ---------------------------------------------------------------------------
// Fake timers (setInterval / setTimeout / cleanup)
// ---------------------------------------------------------------------------

export function createTimers() {
  let now = 0;
  let sequence = 0;
  const pending = new Map();

  const schedule = (fn, delay, interval, args) => {
    sequence += 1;
    const id = sequence;
    const wait = Number(delay);
    pending.set(id, {id, fn, args, interval, delay: Number.isFinite(wait) && wait >= 0 ? wait : 0, at: now + (Number.isFinite(wait) && wait >= 0 ? wait : 0)});
    return id;
  };

  const timers = {
    setInterval(fn, delay, ...args) {
      return schedule(fn, delay, true, args);
    },
    setTimeout(fn, delay, ...args) {
      return schedule(fn, delay, false, args);
    },
    clearInterval(id) {
      pending.delete(id);
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      let guard = 0;
      for (;;) {
        let next = null;
        for (const timer of pending.values()) {
          if (timer.at > target) continue;
          if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) next = timer;
        }
        if (!next) break;
        now = next.at;
        if (next.interval) next.at = now + Math.max(1, next.delay);
        else pending.delete(next.id);
        next.fn(...next.args);
        guard += 1;
        if (guard > 10000) throw new Error('fake timer runaway (>10000 callbacks)');
      }
      now = target;
    },
    pendingCount() {
      return pending.size;
    },
    pendingIntervals() {
      return [...pending.values()].filter((timer) => timer.interval).length;
    },
    reset() {
      pending.clear();
      now = 0;
    },
    now() {
      return now;
    },
  };
  return timers;
}

// ---------------------------------------------------------------------------
// Minimal React-compatible runtime (createElement + hooks)
// ---------------------------------------------------------------------------

const ELEMENT = Symbol('lw.react.element');
const FRAGMENT = Symbol('lw.react.fragment');
const NEVER = Symbol('lw.react.never');

export function createReactRuntime(documentRef) {
  const instances = new Map();
  let current = null;
  let dirty = false;
  let renderQueued = false;
  let mounted = false;
  let disposed = false;
  let rootType = null;
  let rootProps = {};
  let lastTree = null;
  const renderErrors = [];

  function createElement(type, props, ...children) {
    const nextProps = Object.assign({}, props ?? {});
    if (children.length === 1) nextProps.children = children[0];
    else if (children.length > 1) nextProps.children = children;
    else if (!('children' in nextProps)) nextProps.children = undefined;
    const key = nextProps.key ?? null;
    delete nextProps.key;
    return {[ELEMENT]: true, type, props: nextProps, key};
  }

  function isElement(value) {
    return typeof value === 'object' && value !== null && value[ELEMENT] === true;
  }

  function sameDeps(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => Object.is(value, b[index]));
  }

  function useHookSlot(kind, init) {
    if (!current) throw new Error('react stub: hook called outside render');
    const instance = current.instance;
    const index = current.hookIndex;
    current.hookIndex += 1;
    let slot = instance.hooks[index];
    if (!slot || slot.kind !== kind) {
      slot = init();
      instance.hooks[index] = slot;
    }
    return slot;
  }

  function useState(initial) {
    const instance = current.instance;
    const slot = useHookSlot('state', () => ({kind: 'state', value: typeof initial === 'function' ? initial() : initial}));
    const setState = (next) => {
      if (disposed || !instance.mounted) return;
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      dirty = true;
      scheduleRender();
    };
    return [slot.value, setState];
  }

  function useRef(initial) {
    return useHookSlot('ref', () => ({kind: 'ref', value: {current: initial}})).value;
  }

  function useMemo(factory, deps) {
    const slot = useHookSlot('memo', () => ({kind: 'memo', deps: NEVER, value: undefined}));
    const memoDeps = deps === undefined ? undefined : Array.isArray(deps) ? deps.slice() : [deps];
    if (slot.deps === NEVER || memoDeps === undefined || !sameDeps(slot.deps, memoDeps)) {
      slot.value = factory();
      slot.deps = memoDeps;
    }
    return slot.value;
  }

  function useCallback(callback, deps) {
    return useMemo(() => callback, deps);
  }

  function useEffect(effect, deps) {
    const slot = useHookSlot('effect', () => ({kind: 'effect', deps: NEVER, cleanup: null, pending: false, pendingFn: null, pendingDeps: undefined}));
    slot.pending = true;
    slot.pendingFn = effect;
    slot.pendingDeps = deps === undefined ? undefined : Array.isArray(deps) ? deps.slice() : [deps];
  }

  const react = {createElement, Fragment: FRAGMENT, useState, useEffect, useRef, useMemo, useCallback};

  function scheduleRender() {
    if (disposed || renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      if (disposed || !mounted) return;
      renderNow();
    });
  }

  function renderNode(element, path) {
    if (element === null || element === undefined || typeof element === 'boolean') return null;
    if (typeof element === 'string') return element;
    if (typeof element === 'number') return String(element);
    if (Array.isArray(element)) {
      return element.map((child, index) => renderNode(child, `${path}[${index}]`)).filter((child) => child !== null);
    }
    if (!isElement(element)) return null;
    const {type, props} = element;
    if (type === FRAGMENT) return renderNode(props.children, `${path}<>`);
    if (typeof type === 'function') {
      let instance = instances.get(path);
      if (instance && instance.type !== type) {
        unmountInstance(instance);
        instance = undefined;
      }
      if (!instance) {
        instance = {type, path, hooks: [], mounted: true, visited: false};
        instances.set(path, instance);
      }
      instance.visited = true;
      const previous = current;
      current = {instance, hookIndex: 0};
      let output;
      try {
        output = type(props);
      } catch (error) {
        current = previous;
        throw error;
      }
      current = previous;
      const children = renderNode(output, `${path}>`);
      return {tag: '#component', component: type.name || 'Anonymous', props, children: children === null ? [] : Array.isArray(children) ? children : [children]};
    }
    const children = renderNode(props.children, `${path}$`);
    let refNode = null;
    if (props.ref && typeof props.ref === 'object') {
      refNode = documentRef.createElement(typeof type === 'string' ? type : 'div');
      try {
        props.ref.current = refNode;
      } catch {
        refNode = null;
      }
    }
    return {tag: typeof type === 'string' ? type : '#unknown', props, children: children === null ? [] : Array.isArray(children) ? children : [children], refNode};
  }

  function runCleanup(instance) {
    if (!instance) return;
    for (const slot of instance.hooks) {
      if (slot && slot.kind === 'effect' && typeof slot.cleanup === 'function') {
        try {
          slot.cleanup();
        } catch (error) {
          renderErrors.push(error);
        }
        slot.cleanup = null;
      }
    }
  }

  function unmountInstance(instance) {
    runCleanup(instance);
    instance.mounted = false;
    instances.delete(instance.path);
  }

  function renderRoot() {
    for (const instance of instances.values()) instance.visited = false;
    const element = createElement(rootType, rootProps);
    lastTree = renderNode(element, 'root');
    const stale = [];
    for (const instance of instances.values()) {
      if (!instance.visited) stale.push(instance);
    }
    for (const instance of stale) unmountInstance(instance);
  }

  function flushEffects() {
    let ran = false;
    for (const instance of instances.values()) {
      for (const slot of instance.hooks) {
        if (!slot || slot.kind !== 'effect' || !slot.pending) continue;
        slot.pending = false;
        const deps = slot.pendingDeps;
        const shouldRun = slot.deps === NEVER || deps === undefined || !sameDeps(slot.deps, deps);
        if (!shouldRun) continue;
        if (typeof slot.cleanup === 'function') {
          try {
            slot.cleanup();
          } catch (error) {
            renderErrors.push(error);
          }
        }
        slot.cleanup = null;
        slot.deps = deps === undefined ? undefined : deps;
        try {
          const cleanup = slot.pendingFn();
          if (typeof cleanup === 'function') slot.cleanup = cleanup;
        } catch (error) {
          renderErrors.push(error);
        }
        ran = true;
      }
    }
    return ran;
  }

  function renderNow() {
    if (disposed || !mounted || typeof rootType !== 'function') return false;
    let rendered = false;
    for (let turn = 0; turn < 50; turn += 1) {
      const needsRender = dirty || !rendered;
      if (!needsRender) break;
      dirty = false;
      renderRoot();
      rendered = true;
      const ranEffects = flushEffects();
      if (!dirty && !ranEffects) break;
    }
    return rendered;
  }

  const runtime = {
    react,
    createElement,
    mount(type, props = {}) {
      if (disposed) throw new Error('react stub: runtime already disposed');
      mounted = true;
      rootType = type;
      rootProps = props;
      dirty = true;
      renderNow();
      return runtime.tree();
    },
    renderNow,
    async settle(maxTurns = 25) {
      let idle = 0;
      for (let turn = 0; turn < maxTurns && idle < 3; turn += 1) {
        await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
        const rendered = renderNow();
        if (rendered || dirty) idle = 0;
        else idle += 1;
      }
      if (runtime.renderErrors.length > 0) {
        const error = runtime.renderErrors.shift();
        throw error;
      }
      return runtime.tree();
    },
    tree() {
      return lastTree;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const instance of [...instances.values()]) unmountInstance(instance);
      instances.clear();
    },
    get disposed() {
      return disposed;
    },
    renderErrors,
  };
  return runtime;
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

export function walkTree(node, visitor) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') return;
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, visitor);
    return;
  }
  visitor(node);
  for (const child of node.children ?? []) walkTree(child, visitor);
}

export function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  return (node.children ?? []).map(textOf).join('');
}

export function findNodes(tree, predicate) {
  const found = [];
  walkTree(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

export function findButton(tree, label) {
  return findNodes(tree, (node) => node.tag === 'button' && textOf(node).includes(label))[0] ?? null;
}

export function findCheckbox(tree, label) {
  return findNodes(tree, (node) => node.tag === 'input' && node.props?.type === 'checkbox' && String(node.props?.['aria-label'] ?? node.props?.label ?? '').includes(label))[0] ?? null;
}

// ---------------------------------------------------------------------------
// Fake RPC connection
// ---------------------------------------------------------------------------

export function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return {promise, resolve: resolvePromise, reject: rejectPromise};
}

export function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export const API_CHANNEL = '/local-workbench';

export function makeContext(overrides = {}) {
  return {
    context_ref: 'ctx-a',
    scope_ref: 'scope-a',
    scope_generation: 1,
    session_ref: null,
    context_revision: 'ctx-rev-1',
    profile_ref: 'profile-a',
    profile_revision: 1,
    selected_module_ids: ['05', '07'],
    allowed_module_ids: ['05', '06', '07'],
    label: '工作区 A',
    active: true,
    ...overrides,
  };
}

export function makeModule(overrides = {}) {
  return {
    schema_version: 1,
    module_id: '05',
    scope_ref: 'scope-a',
    session_ref: null,
    generation: 1,
    revision: 1,
    state: 'ready',
    reason_code: null,
    active_operations: [],
    updated_at: '2026-11-06T08:00:00.000Z',
    capabilities: ['memory.recall'],
    ...overrides,
  };
}

export function makeStatusData(payload, overrides = {}) {
  return {
    changed: true,
    revision: 1,
    scope_ref: 'scope-a',
    scope_generation: payload?.expected_scope_generation ?? 1,
    context_revision: 'ctx-rev-1',
    diagnostics: [],
    modules: [],
    ...overrides,
  };
}

export function makeIntent(overrides = {}) {
  return {
    schema_version: 1,
    intent_id: 'intent-1',
    operation_id: 'intent-op-1',
    owner_module: '05',
    scope_ref: 'scope-a',
    scope_generation: 1,
    context_revision: 'ctx-rev-1',
    module_revision: 1,
    composition_digest: 'a'.repeat(64),
    expires_at: new Date(Date.now() + 30000).toISOString(),
    target: {kind: 'panel', panel_key: 'local-memory'},
    ...overrides,
  };
}

export function okResponse(payload, data, overrides = {}) {
  return {
    schema_version: 1,
    operation_id: payload?.operation_id,
    view_epoch: payload?.view_epoch ?? 0,
    scope_generation: payload?.expected_scope_generation ?? 1,
    status: 'ok',
    data,
    ...overrides,
  };
}

export function failResponse(payload, status, reasonCode, overrides = {}) {
  return {
    schema_version: 1,
    operation_id: payload?.operation_id,
    view_epoch: payload?.view_epoch ?? 0,
    scope_generation: payload?.expected_scope_generation ?? 1,
    status,
    reason_code: reasonCode,
    ...overrides,
  };
}

export function acceptedActionResult(payload, intent, overrides = {}) {
  return {
    schema_version: 1,
    operation_id: payload?.operation_id,
    status: 'accepted',
    owner_module: intent?.owner_module ?? '05',
    reason_code: null,
    navigation_intent: intent,
    ...overrides,
  };
}

export function rejectedActionResult(payload, status = 'denied', reasonCode = 'MODULE_DENIED', overrides = {}) {
  return {
    schema_version: 1,
    operation_id: payload?.operation_id,
    status,
    owner_module: '05',
    reason_code: reasonCode,
    navigation_intent: null,
    ...overrides,
  };
}

export function defaultContextListData() {
  return {contexts: [makeContext()], diagnostics: [], fixture_mode: false, modules: []};
}

// Read-only catalog summary row emitted by context.list.data.modules (T4 follow-up).
export function makeCatalogRow(overrides = {}) {
  return {
    module_id: '05',
    name: 'Local Memory',
    release_version: '0.0.0-fixture',
    entry_kind: 'panel',
    fixture: true,
    ...overrides,
  };
}

export function createRpc() {
  const calls = [];
  const handlers = new Map();
  const defaults = new Map();

  const invoke = async (endpoint, payload, signal, record) => {
    if (signal?.aborted) throw abortError();
    const handler = handlers.get(endpoint) ?? defaults.get(endpoint);
    if (!handler) throw new Error(`unexpected RPC endpoint in test: ${endpoint}`);
    const value = await handler(payload, signal, record);
    if (signal?.aborted) throw abortError();
    return value;
  };

  defaults.set('context.list', (payload) => okResponse(payload, defaultContextListData()));
  defaults.set('status.get', (payload) => okResponse(payload, makeStatusData(payload, {changed: false, revision: 0, modules: []})));

  const rpc = {
    defaults,
    handlers,
    calls,
    handle(endpoint, handler) {
      if (handler === null) handlers.delete(endpoint);
      else handlers.set(endpoint, handler);
      return rpc;
    },
    setResponse(endpoint, handler) {
      return rpc.handle(endpoint, handler);
    },
    useDefault(endpoint) {
      handlers.delete(endpoint);
      return rpc;
    },
    async call(channel, endpoint, payload, signal) {
      const record = {channel, endpoint, payload, signal, at: calls.length};
      calls.push(record);
      if (signal?.aborted) throw abortError();
      const raw = await invoke(endpoint, payload, signal, record);
      // Convenience for tests: a bare BusinessResponse handler result is wrapped
      // into the real RpcResult envelope {ok:true, value}. Handlers may also
      // return an explicit RpcResult (used for transport-failure tests).
      if (raw && typeof raw === 'object' && raw.ok === undefined && raw.schema_version === 1) {
        return {ok: true, value: raw};
      }
      return raw;
    },
    callsFor(endpoint) {
      return calls.filter((call) => call.endpoint === endpoint);
    },
    payloadsFor(endpoint) {
      return calls.filter((call) => call.endpoint === endpoint).map((call) => call.payload);
    },
    lastPayload(endpoint) {
      const matching = calls.filter((call) => call.endpoint === endpoint);
      return matching.length === 0 ? null : matching[matching.length - 1].payload;
    },
    endpoints() {
      return calls.map((call) => call.endpoint);
    },
    reset() {
      calls.length = 0;
    },
  };
  return rpc;
}

// ---------------------------------------------------------------------------
// Fake slots / layout / cordis ctx
// ---------------------------------------------------------------------------

export function createSlots() {
  const entries = [];
  const injections = [];
  return {
    entries,
    injections,
    entriesOfSlot(name) {
      return entries.filter((entry) => entry.options?.name === name);
    },
    entriesFor(name) {
      return this.entriesOfSlot(name);
    },
    inject(name, callback) {
      injections.push(name);
      const dispose = callback();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    register(options, component) {
      const entry = {options, component};
      entries.push(entry);
      return () => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
      };
    },
    registerForeign(name, options, component = () => null) {
      return this.register({name, ...options}, component);
    },
    provideRoot() {
      return () => {};
    },
    subscribe() {
      return () => {};
    },
  };
}

export function createLayout(slots) {
  let navigationController = null;
  return {
    selection: [],
    navigationSignals: [],
    activePanelId: undefined,
    selectPanel(panelId) {
      this.selection.push(panelId);
      if (panelId !== null) {
        const registered = slots.entriesOfSlot('main').some((entry) => entry.options?.key === panelId);
        if (!registered) throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`);
      }
      this.activePanelId = panelId;
    },
    beginNavigation() {
      if (navigationController) navigationController.abort();
      navigationController = new AbortController();
      this.navigationSignals.push(navigationController.signal);
      return navigationController.signal;
    },
    toggleSidebar() {},
  };
}

export function createCtx({slots, layout, connection, extras = {}}) {
  const effects = [];
  const ctx = {
    slots,
    layout,
    connection,
    effects,
    effect(effectFactory, label) {
      const dispose = effectFactory();
      const record = {label, dispose: typeof dispose === 'function' ? dispose : null, disposed: false, at: effects.length};
      effects.push(record);
      return () => {
        if (record.disposed) return;
        record.disposed = true;
        if (typeof record.dispose === 'function') record.dispose();
      };
    },
    provide(name, value) {
      extras[name] = value;
    },
    reflect: {
      provide(name, value) {
        extras[name] = value;
      },
    },
    get(name) {
      return extras[name];
    },
    inject(names, callback) {
      callback(ctx);
    },
    locale: undefined,
    dispose() {
      for (let index = effects.length - 1; index >= 0; index -= 1) {
        const record = effects[index];
        if (record.disposed) continue;
        record.disposed = true;
        try {
          if (typeof record.dispose === 'function') record.dispose();
        } catch (error) {
          effects.__errors = effects.__errors ?? [];
          effects.__errors.push(error);
        }
      }
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ENV_KEYS = ['window', 'document', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'navigator'];

function captureGlobalEnvironment() {
  const saved = new Map();
  for (const key of ENV_KEYS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key) ?? null);
  }
  return saved;
}

function restoreGlobalEnvironment(saved) {
  for (const [key, descriptor] of saved) {
    try {
      if (descriptor === null) delete globalThis[key];
      else Object.defineProperty(globalThis, key, descriptor);
    } catch {
      // best effort; the next harness overwrites the key anyway
    }
  }
}

function installGlobalEnvironment({windowRef, documentRef, timers, navigatorValue}) {
  Object.defineProperty(globalThis, 'window', {configurable: true, writable: true, value: windowRef});
  Object.defineProperty(globalThis, 'document', {configurable: true, writable: true, value: documentRef});
  Object.defineProperty(globalThis, 'setInterval', {configurable: true, writable: true, value: timers.setInterval});
  Object.defineProperty(globalThis, 'clearInterval', {configurable: true, writable: true, value: timers.clearInterval});
  Object.defineProperty(globalThis, 'setTimeout', {configurable: true, writable: true, value: timers.setTimeout});
  Object.defineProperty(globalThis, 'clearTimeout', {configurable: true, writable: true, value: timers.clearTimeout});
  if (navigatorValue !== undefined) {
    Object.defineProperty(globalThis, 'navigator', {configurable: true, writable: true, value: navigatorValue});
  }
}

export function readBundleSource() {
  return readFileSync(BUNDLE_FILE, 'utf8');
}

export async function createHarness(options = {}) {
  const documentRef = createDocument();
  const timers = createTimers();
  const rpc = createRpc();
  const slots = createSlots();
  const layout = createLayout(slots);
  const connection = {rpc};
  const ctx = createCtx({slots, layout, connection, extras: options.extras ?? {}});
  const reactRuntime = createReactRuntime(documentRef);
  const requires = [];
  const windowRef = {
    __ModuleLoader__: {
      registrations: [],
      load(registration) {
        this.registrations.push(registration);
      },
    },
    document: documentRef,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  };
  const savedEnvironment = captureGlobalEnvironment();
  installGlobalEnvironment({windowRef, documentRef, timers, navigatorValue: options.navigator});

  let loadError = null;
  let source = '';
  try {
    source = readBundleSource();
    vm.runInThisContext(source, {filename: BUNDLE_FILE});
  } catch (error) {
    loadError = error;
  }

  const registrations = windowRef.__ModuleLoader__.registrations;
  const registration = registrations[0] ?? null;
  let plugin = null;
  let factoryError = null;
  if (registration) {
    const requireStub = (id) => {
      requires.push(id);
      if (id === 'react') return reactRuntime.react;
      throw new Error(`bundle required a non-static module: ${id}`);
    };
    try {
      plugin = registration.factory(requireStub);
    } catch (error) {
      factoryError = error;
    }
  }

  const harness = {
    projectRoot: PROJECT_ROOT,
    bundleFile: BUNDLE_FILE,
    source,
    loadError,
    registrations,
    registration,
    requires,
    plugin,
    factoryError,
    window: windowRef,
    document: documentRef,
    timers,
    rpc,
    api: rpc,
    slots,
    layout,
    ctx,
    react: reactRuntime,
    errors: reactRuntime.renderErrors,
    apply() {
      if (plugin === null) throw factoryError ?? new Error('client module factory did not run');
      plugin.apply(ctx);
      return harness;
    },
    async boot() {
      harness.apply();
      harness.mountMain();
      await harness.flush();
      return harness;
    },
    mountMain() {
      const entry = harness.mainEntry();
      if (!entry) throw new Error('main slot "local-workbench" is not registered');
      reactRuntime.mount(entry.component, {});
      return harness;
    },
    mainEntry() {
      return slots.entriesOfSlot('main').find((entry) => entry.options?.key === 'local-workbench') ?? null;
    },
    panellistEntry() {
      return slots.entriesOfSlot('sidebar.panellist').find((entry) => entry.options?.id === 'local-workbench') ?? null;
    },
    tree() {
      return reactRuntime.tree();
    },
    text() {
      return textOf(reactRuntime.tree());
    },
    find(predicate) {
      return findNodes(reactRuntime.tree(), predicate);
    },
    findText(needle) {
      return textOf(reactRuntime.tree()).includes(needle);
    },
    buttons() {
      return findNodes(reactRuntime.tree(), (node) => node.tag === 'button').map((node) => ({
        node,
        text: textOf(node),
        disabled: node.props?.disabled === true,
        type: node.props?.type,
        onClick: node.props?.onClick,
      }));
    },
    button(label) {
      return harness.buttons().find((button) => button.text.includes(label)) ?? null;
    },
    click(label) {
      const button = harness.button(label);
      if (!button) throw new Error(`button containing ${JSON.stringify(label)} not found in: ${harness.text()}`);
      if (typeof button.onClick !== 'function') throw new Error(`button ${JSON.stringify(label)} has no onClick`);
      button.onClick({preventDefault() {}, stopPropagation() {}, currentTarget: button.node});
      return button;
    },
    checkboxes() {
      return findNodes(reactRuntime.tree(), (node) => node.tag === 'input' && node.props?.type === 'checkbox').map((node) => ({
        node,
        label: String(node.props?.['aria-label'] ?? ''),
        checked: node.props?.checked === true,
        onChange: node.props?.onChange,
      }));
    },
    async flush() {
      await reactRuntime.settle();
      return harness;
    },
    async settle() {
      await reactRuntime.settle();
      return harness;
    },
    async advance(ms) {
      timers.advance(ms);
      await reactRuntime.settle();
      return harness;
    },
    setVisibility(state) {
      documentRef.__setVisibility(state);
      return harness;
    },
    styleNode() {
      return documentRef.querySelector('style[data-local-workbench]');
    },
    styleCount() {
      return documentRef.querySelectorAll('style[data-local-workbench]').length;
    },
    visibilityListenerCount() {
      return documentRef.listenerCount('visibilitychange');
    },
    unmountPanel() {
      reactRuntime.dispose();
      return harness;
    },
    dispose() {
      reactRuntime.dispose();
      ctx.dispose();
      restoreGlobalEnvironment(savedEnvironment);
      return harness;
    },
  };
  return harness;
}
