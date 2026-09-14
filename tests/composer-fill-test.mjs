// "Fill into composer" — the path that hands an edited message to the REAL
// composer so the rewrite keeps @-mentions, / commands and attachments.
//
// This drives the real factory against a fake cordis context that provides a
// fake `conversation` service, and asserts which channel the plugin writes
// through and how it behaves when that service is missing or broken.
//
// Usage:  node tests/composer-fill-test.mjs
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

/**
 * Build the plugin against a fake world.
 * @param {object} options.shell - what `conversation.input.for(actx)` returns.
 * @param {boolean} options.withConversation - whether the service is injected.
 * @param {boolean} options.withBinding - whether the session binding resolves.
 */
function build({ shell = null, withConversation = true, withBinding = true, inputShape = 'for' } = {}) {
  const calls = { for: [], setDraft: [], focuses: [] };
  const warnings = [];

  const ReactStub = {
    useReducer: () => [0, () => {}], useEffect: () => {}, useRef: () => ({ current: null }),
    useState: (v) => [v, () => {}], useCallback: (f) => f, useMemo: (f) => f(), useLayoutEffect: () => {},
    createElement: (t, p, ...c) => ({ type: t, props: p, children: c }),
    Component: class { constructor(p) { this.props = p; this.state = {}; } },
    Fragment: Symbol('F')
  };
  const jsxRuntime = (() => {
    const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: Symbol('F') };
  })();

  const conversationService = {
    input: inputShape === 'for'
      ? { for: (actx) => { calls.for.push(actx); return shell; } }
      : {}
  };

  const sandbox = {
    console: {
      log() {},
      info() {},
      warn: (...a) => warnings.push(String(a[0])),
      error() {}
    },
    Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, Map, Set, Symbol, Error, RegExp,
    parseInt, parseFloat, isNaN, encodeURIComponent,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: (fn) => { fn(); return 0; },
    navigator: { clipboard: {} },
    MutationObserver: class { observe() {} disconnect() {} },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };

  /** Records what focusComposer would focus. */
  const seat = { focus() { calls.focuses.push(true); } };
  sandbox.document = {
    head: { appendChild() {}, lastElementChild: null },
    body: { appendChild() {} },
    getElementById: () => null,
    createElement: () => ({ dataset: {}, style: {}, appendChild() {}, remove() {}, addEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {} } }),
    querySelector: () => seat,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    createTreeWalker: () => ({ nextNode: () => null })
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

  const sessionBinding = { ctx: { scoped: true } };
  const ctx = {
    effect(fn, label) { try { fn(); } catch { /* dictionaries */ } void label; },
    locale: { register: () => () => {}, bind: () => (k) => k },
    slots: { inject: (name, cb) => cb(), register: () => () => {} },
    inject(services, cb) {
      const bag = { sessions: { binding: () => (withBinding ? sessionBinding : undefined), list: { getSnapshot: () => ({ selectedId: 'session-A' }) } } };
      if (withConversation && services.includes('conversation')) bag.conversation = conversationService;
      if (services.includes('conversation') && !withConversation) return; // service absent
      cb(bag);
    },
    logger: { info() {}, warn: () => {}, error() {} }
  };

  mod.apply(ctx);
  return { fillComposer: mod.__internals.fillComposer, calls, warnings };
}

console.log('dsh-better-uiux "fill into composer"\n');

console.log('1. happy path writes through the documented channel');
{
  const shell = { actions: { setDraft: null } };
  const built = build({ shell });
  built.calls.setDraft.length = 0;
  shell.actions.setDraft = (text) => built.calls.setDraft.push(text);

  const outcome = built.fillComposer('session-A', 'rewritten text with @file and /cmd');
  check('reports success', outcome.ok === true, JSON.stringify(outcome));
  check('asked the service for the session-scoped facade', built.calls.for.length === 1);
  check('passed the session binding ctx', built.calls.for[0] === built.calls.for[0] && built.calls.for[0]?.scoped === true);
  check('called actions.setDraft exactly once', built.calls.setDraft.length === 1);
  check('drafted the exact text', built.calls.setDraft[0] === 'rewritten text with @file and /cmd', built.calls.setDraft[0]);
  check('focused the composer', built.calls.focuses.length >= 1);
}

console.log('\n2. no conversation service -> reported, never throws');
{
  const built = build({ shell: null, withConversation: false });
  const outcome = built.fillComposer('session-A', 'x');
  check('ok=false', outcome.ok === false, JSON.stringify(outcome));
  check('reason names the missing composer', outcome.reason === 'no-composer', outcome.reason);
}

console.log('\n3. no session binding -> reported, never throws');
{
  const built = build({ shell: { actions: { setDraft() {} } }, withBinding: false });
  const outcome = built.fillComposer('session-A', 'x');
  check('ok=false', outcome.ok === false, JSON.stringify(outcome));
  check('reason names the missing composer', outcome.reason === 'no-composer', outcome.reason);
}

console.log('\n4. facade without actions.setDraft -> reported');
{
  const built = build({ shell: { actions: {} } });
  const outcome = built.fillComposer('session-A', 'x');
  check('ok=false', outcome.ok === false, JSON.stringify(outcome));
  check('reason names setDraft', outcome.reason === 'no-setDraft', outcome.reason);
}

console.log('\n5. service present but shaped differently -> reported, not crashed');
{
  const built = build({ shell: null, inputShape: 'empty' });
  const outcome = built.fillComposer('session-A', 'x');
  check('ok=false', outcome.ok === false, JSON.stringify(outcome));
  check('reason names the missing composer', outcome.reason === 'no-composer', outcome.reason);
}

console.log('\n6. setDraft throwing is contained');
{
  const built = build({ shell: { actions: { setDraft() { throw new Error('locked'); } } } });
  const outcome = built.fillComposer('session-A', 'x');
  check('ok=false', outcome.ok === false, JSON.stringify(outcome));
  check('reason names the throw', outcome.reason === 'setDraft-threw', outcome.reason);
}

console.log('\n7. a bad session id is refused before touching the service');
{
  const built = build({ shell: { actions: { setDraft() {} } } });
  const outcome = built.fillComposer('', 'x');
  check('ok=false', outcome.ok === false);
  check('reason names the missing composer', outcome.reason === 'no-composer', outcome.reason);
  check('the service was never called', built.calls.for.length === 0);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exitCode = 1;
} else {
  console.log('composer fill ok');
}
