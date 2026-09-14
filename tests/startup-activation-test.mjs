// Startup activation regression test.
//
// THE BUG THIS EXISTS FOR: feature activation used to run only when the host
// config DIFFERED from the cached one. On a reload they are identical, so
// nothing was ever started — the Edit button only appeared after the user touched
// a switch in Settings (which runs commit()). That is a silent, reload-only
// failure, so it gets a dedicated test.
//
// Edit message is now temporarily hidden (`EDIT_MESSAGE_HIDDEN`), so the reload
// activation is observed through the custom-CSS style tag instead: it is written
// from the CACHE at module scope, which means an EMPTY tag after the host answered
// can only come from `syncFeatures()` having re-run. The stale fixture still says
// `editMessage: true` on purpose — the editor must stay off anyway.
//
// It drives the real factory with:
//   - localStorage pre-seeded so the cache matches the host answer (the reload case)
//   - a fake conversation/session environment
//   - a fake user-message row that the editor would decorate if it were enabled
//
// Usage:  node tests/startup-activation-test.mjs
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let checks = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) console.log(`  ok    ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

const CONFIG = {
  // `editMessage: true` is deliberate: Edit message is hidden, so a config that
  // claims it is on must change nothing.
  features: { liveTerminal: true, customCss: true, editMessage: true },
  css: '/* user css */'
};

/** A fake element good enough for the editor's decorate/cleanup paths. */
function makeElement(tag = 'div', attrs = {}) {
  const el = {
    tagName: String(tag).toUpperCase(),
    attrs: new Map(Object.entries(attrs)),
    children: [],
    parentElement: null,
    dataset: {},
    style: { cssText: '' },
    className: '',
    textContent: '',
    innerHTML: '',
    title: '',
    disabled: false,
    listeners: new Map(),
    get id() { return this.attrs.get('id') ?? ''; },
    set id(v) { this.attrs.set('id', v); },
    getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; },
    setAttribute(n, v) { this.attrs.set(n, String(v)); return this; },
    removeAttribute(n) { this.attrs.delete(n); },
    hasAttribute(n) { return this.attrs.has(n); },
    /** `row.classList.add(EDIT_HOST_CLASS)` is part of the decorate path. */
    classList: {
      add: (...names) => {
        const parts = String(el.className).split(/\s+/).filter(Boolean);
        for (const name of names) if (!parts.includes(name)) parts.push(name);
        el.className = parts.join(' ');
      },
      remove: (...names) => {
        const parts = String(el.className).split(/\s+/).filter(Boolean).filter((p) => !names.includes(p));
        el.className = parts.join(' ');
      },
      contains: (name) => String(el.className).split(/\s+/).includes(name),
      toggle: (name) => {
        if (el.classList.contains(name)) el.classList.remove(name);
        else el.classList.add(name);
      }
    },
    appendChild(c) { c.parentElement = el; el.children.push(c); return c; },
    insertBefore(c, ref) {
      const i = ref === null || ref === undefined ? el.children.length : el.children.indexOf(ref);
      c.parentElement = el;
      el.children.splice(i < 0 ? el.children.length : i, 0, c);
      return c;
    },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentElement = null; return c; },
    remove() { if (el.parentElement !== null) el.parentElement.removeChild(el); },
    contains(n) { let c = n; while (c) { if (c === el) return true; c = c.parentElement; } return false; },
    closest() { return null; },
    addEventListener(t, h) { if (!el.listeners.has(t)) el.listeners.set(t, new Set()); el.listeners.get(t).add(h); },
    removeEventListener(t, h) { el.listeners.get(t)?.delete(h); },
    _match(sel) {
      const selector = sel.trim();
      if (selector === '*') return true;
      // Compound selectors: walk `tag`, `.class`, `#id` and `[attr]` / `[attr="v"]`
      // tokens. The real code queries things like
      // `[data-chat-flow-kind="user"][data-chat-flow-key]`, so a single
      // whole-string regex is not enough.
      let i = 0;
      while (i < selector.length) {
        const ch = selector[i];
        if (ch === '[') {
          const end = selector.indexOf(']', i);
          if (end < 0) return false;
          const body = selector.slice(i + 1, end);
          // `[class*="_actions"]` — substring form, used by the row fallback.
          const star = body.indexOf('*=');
          if (star >= 0) {
            const name = body.slice(0, star);
            let want = body.slice(star + 2);
            if ((want.startsWith('"') && want.endsWith('"')) || (want.startsWith("'") && want.endsWith("'"))) {
              want = want.slice(1, -1);
            }
            const actual = name === 'class' ? String(el.className) : el.getAttribute(name);
            if (actual === null || !actual.includes(want)) return false;
            i = end + 1;
            continue;
          }
          const eq = body.indexOf('=');
          if (eq < 0) {
            if (el.getAttribute(body) === null) return false;
          } else {
            const name = body.slice(0, eq);
            let want = body.slice(eq + 1);
            if ((want.startsWith('"') && want.endsWith('"')) || (want.startsWith("'") && want.endsWith("'"))) {
              want = want.slice(1, -1);
            }
            const actual = el.getAttribute(name);
            if (actual === null) return false;
            if (actual !== want) return false;
          }
          i = end + 1;
          continue;
        }
        if (ch === '.') {
          let j = i + 1;
          while (j < selector.length && /[\w-]/.test(selector[j])) j += 1;
          const name = selector.slice(i + 1, j);
          if (name !== '' && !String(el.className).split(/\s+/).includes(name)) return false;
          i = j;
          continue;
        }
        if (ch === '#') {
          let j = i + 1;
          while (j < selector.length && /[\w-]/.test(selector[j])) j += 1;
          if (el.getAttribute('id') !== selector.slice(i + 1, j)) return false;
          i = j;
          continue;
        }
        // Element name.
        let j = i;
        while (j < selector.length && /[\w-]/.test(selector[j])) j += 1;
        const name = selector.slice(i, j);
        if (name === '') return false;
        if (el.tagName !== name.toUpperCase()) return false;
        i = j;
      }
      return true;
    },
    querySelectorAll(sel) {
      const parts = sel.split(',').map((s) => s.trim());
      const out = [];
      const walk = (node) => {
        for (const c of node.children) {
          if (parts.some((p) => c._match(p))) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
    querySelector(sel) { return el.querySelectorAll(sel)[0] ?? null; }
  };
  return el;
}

/**
 * Run the plugin's startup with a cache/host pair.
 * @returns {{ decorated: boolean, observerInstalled: boolean, warnings: string[] }}
 */
async function runStartup({ cachedConfig, hostConfig, rowPresent = true }) {
  const warnings = [];
  let observerInstalled = false;
  let cacheWasRead = false;  const storage = new Map();
  if (cachedConfig !== null) storage.set('dsh_better_uiux_config_v2', JSON.stringify(cachedConfig));

  // ---- the document ------------------------------------------------------
  const doc = makeElement('html');
  const head = makeElement('head');
  const body = makeElement('body');
  doc.appendChild(head);
  doc.appendChild(body);

  /** The user-message row the editor should decorate. */
  let row = null;
  if (rowPresent) {
    row = makeElement('div', { 'data-chat-flow-kind': 'user', 'data-chat-flow-key': 'k1', 'data-chat-turn': '2' });
    const stack = makeElement('div');
    const bubble = makeElement('div');
    bubble.className = 'bubble';
    const actions = makeElement('div');
    actions.className = 'qJxi1G_actions';
    const clock = makeElement('span', { class: 'qJxi1G_timeStart' });
    clock.className = 'qJxi1G_timeStart';
    const copy = makeElement('button', { 'aria-label': 'Copy' });
    copy.className = 'qJxi1G_action';
    actions.appendChild(clock);
    actions.appendChild(copy);
    stack.appendChild(bubble);
    row.appendChild(stack);
    row.appendChild(actions);
    // Attach the row to documentElement, NOT body: the stub's querySelectorAll
    // only walks descendants, and the plugin queries from the document root.
    // (Use the real app element, like the shell does.)
    doc.appendChild(row);
  }

  const documentStub = {
    head,
    body,
    documentElement: doc,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    createElement: (t) => makeElement(t),
    getElementById: (id) => doc.querySelectorAll('[id]').find((el) => el.getAttribute('id') === id) ?? null,
    querySelector: (sel) => doc.querySelector(sel),
    querySelectorAll: (sel) => doc.querySelectorAll(sel),
    addEventListener() {},
    removeEventListener() {},
    createTreeWalker: () => ({ nextNode: () => null })
  };

  // ---- the sandbox ------------------------------------------------------
  const ReactStub = {
    useReducer: () => [0, () => {}], useEffect: () => {}, useRef: () => ({ current: null }),
    useState: (v) => [v, () => {}], useCallback: (f) => f, useMemo: (f) => f(), useLayoutEffect: () => {},
    createElement: (t, p, ...c) => ({ type: t, props: p, children: c }),
    Component: class { constructor(p) { this.props = p; this.state = {}; } },
    Fragment: Symbol('F')
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const jsxRuntime = { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: Symbol('F') };

  const sandbox = {
    console: {
      log() {},
      info() {},
      // Warnings carry the swallowed exceptions; a regression must not be able to
      // hide behind that catch, so they are collected and asserted on.
      warn: (...a) => {
        warnings.push(a.map((x) => String(x)).join(' '));
      },
      error() {}
    },
    Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, Map, Set, Symbol, Error, RegExp,
    parseInt, parseFloat, isNaN, encodeURIComponent,
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: (fn) => { fn(); return 0; },
    navigator: { clipboard: {} },
    MutationObserver: class {
      constructor() { observerInstalled = true; }
      observe() {}
      disconnect() {}
    },
    NodeFilter: documentStub.NodeFilter,
    fetch: async () => ({ ok: true, status: 200, json: async () => hostConfig }),
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    document: documentStub
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const modules = [];
  sandbox.window.__ModuleLoader__ = { load: ({ id, factory }) => modules.push({ id, factory }) };
  sandbox.require = (spec) => {
    if (spec === 'react') return ReactStub;
    if (spec === 'react/jsx-runtime') return jsxRuntime;
    if (spec === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
    return {};
  };

  new Script(readFileSync(join(pluginDir, 'client.js'), 'utf-8'), { filename: 'client.js' })
    .runInContext(createContext(sandbox), { filename: 'client.js' });

  const core = modules.find((m) => m.id === 'dsh-better-uiux');
  const mod = core.factory(sandbox.require);

  const ctx = {
    effect(fn) { try { fn(); } catch { /* dictionaries */ } },
    locale: { register: () => () => {}, bind: () => (k) => k },
    slots: { inject: (name, cb) => cb(), register: () => () => {} },
    inject(services, cb) {
      const bag = {
        sessions: {
          binding: () => ({ ctx: {}, session: {} }),
          list: { getSnapshot: () => ({ selectedId: 'session-A' }) }
        }
      };
      if (services.includes('conversation')) bag.conversation = { input: { for: () => null } };
      cb(bag);
    },
    logger: { info() {}, warn() {}, error() {} }
  };

  mod.apply(ctx);

  // Sanity: prove the cache really was read, so the "reload" case truly is
  // cache-equals-host. If this were false the test would silently be exercising
  // the first-run path instead, and would not guard the reload bug at all.
  cacheWasRead = sandbox.localStorage.getItem('dsh_better_uiux_config_v2') !== null;

  // Let loadFromHost's fetch promise chain settle.
  for (let i = 0; i < 8; i += 1) await Promise.resolve();

  const editButtons = row === null ? 0 : row.querySelectorAll('.dsh-bu-edit-btn').length;
  // NOTE: `observerInstalled` is reported but NOT asserted any more. The
  // live-terminal half installs a MutationObserver of its own whenever that switch
  // is on, so the flag no longer isolates the (now hidden) message editor. What the
  // editor did is observed through the row itself: `startMessageEditor()` decorates
  // synchronously, so a missing Edit button really does mean it never started.
  // Activation observable that survives the hidden editor: the custom-CSS tag is
  // filled from the CACHE at module scope, so an empty tag after the host answered
  // proves `syncFeatures()` re-ran on this load.
  const cssTag = doc.querySelectorAll('[id]').find((el) => el.getAttribute('id') === 'dsh-better-uiux-style') ?? null;
  const cssText = cssTag === null ? null : cssTag.textContent;
  // The activation guard swallows its error to keep the app alive; surface it
  // here so a regression cannot hide behind that catch.
  const activationFailed = warnings.some((w) => w.includes('feature activation failed'));
  return { editButtons, cssText, observerInstalled, warnings, activationFailed, cacheWasRead };
}

console.log('dsh-better-uiux startup activation\n');

console.log('1. RELOAD case: cache identical to the host answer (the old bug)');
{
  const result = await runStartup({ cachedConfig: CONFIG, hostConfig: CONFIG });
  check('the cached config really was read (cache-equals-host)', result.cacheWasRead === true);
  check('activation did not swallow an error', result.activationFailed === false, JSON.stringify(result.warnings));
  check('the custom CSS is applied after the host answered', result.cssText === '/* user css */', String(result.cssText));
  check('no Edit button while the feature is hidden', result.editButtons === 0, `found ${result.editButtons}`);
}

console.log('\n2. first run: no cache, host says on');
{
  const result = await runStartup({ cachedConfig: null, hostConfig: CONFIG });
  check('activation did not swallow an error', result.activationFailed === false, JSON.stringify(result.warnings));
  check('the host CSS was applied', result.cssText === '/* user css */', String(result.cssText));
  check('no Edit button while the feature is hidden', result.editButtons === 0, `found ${result.editButtons}`);
}

console.log('\n3. host says off -> nothing is injected');
{
  const off = { features: { liveTerminal: false, customCss: false, editMessage: false }, css: '' };
  const result = await runStartup({ cachedConfig: off, hostConfig: off });
  check('no Edit button', result.editButtons === 0, `found ${result.editButtons}`);
  check('no CSS was injected', result.cssText === null || result.cssText === '', String(result.cssText));
}

console.log('\n4. cache on, host off -> the host wins and cleans up');
{
  const off = { features: { liveTerminal: false, customCss: false, editMessage: false }, css: '' };
  const result = await runStartup({ cachedConfig: CONFIG, hostConfig: off });
  check('no Edit button after cleanup', result.editButtons === 0, `found ${result.editButtons}`);
  // The cache wrote this CSS at module scope: it can only be empty because
  // activation re-ran against the host answer.
  check('the cached CSS was cleared by the host answer', result.cssText === '', String(result.cssText));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exitCode = 1;
} else {
  console.log('startup activation ok');
}
