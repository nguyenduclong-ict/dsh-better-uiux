// Resolving the job behind a transcript card's Output button.
//
// THE BUG THIS EXISTS FOR: the button read the job id only off the card's own
// markup. When that parse failed, the click produced no modal and no message —
// indistinguishable from a dead button — while the header job list kept working,
// because that path resolves from the session job STORE instead of the DOM. The
// resolver now falls back to the store; these tests pin each fallback.
//
// Usage:  node tests/card-job-resolve-test.mjs
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

/** A card stub: only what the resolver reads. */
function makeCard({ jobId = null, inText = '', command = '' } = {}) {
  const ioText = { textContent: inText };
  const ioLabel = { textContent: 'IN' };
  const commandEl = { textContent: command };
  const card = {
    dataset: jobId ? { jobId } : {},
    attributes: new Map(),
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    closest: () => null,
    querySelectorAll(selector) {
      if (selector.includes('ioSection')) {
        return [{ querySelector: (s) => (s.includes('ioLabel') ? ioLabel : s.includes('ioText') ? ioText : null) }];
      }
      if (selector.includes('command')) return [commandEl];
      if (selector.includes('title') || selector.includes('summary') || selector.includes('promptLine')) return [];
      return [];
    },
    querySelector(selector) {
      if (selector.includes('title')) return { textContent: 'Tool call' };
      if (selector.includes('summary')) return null;
      if (selector.includes('command')) return commandEl;
      return null;
    }
  };
  return card;
}

/**
 * Load the built bundle and return the live half's internals with a scripted host.
 * @param {Array<object>} jobs - what `/api/better-uiux/jobs` should answer.
 */
function build(jobs) {
  const configured = [];
  const storage = new Map();
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, Map, Set, WeakMap, Symbol,
    Error, RegExp, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    setTimeout: (fn) => { try { fn(); } catch {} return 0; },
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: (fn) => { try { fn(); } catch {} return 0; },
    navigator: { clipboard: {}, userAgent: 'test' },
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1 },
    fetch: async (url) => {
      configured.push(String(url));
      // The job-store fallback.
      return {
        ok: true,
        status: 200,
        json: async () => ({ enabled: true, success: true, jobs })
      };
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    document: {
      head: { appendChild() {}, lastElementChild: null },
      body: { appendChild() {} },
      getElementById: () => null,
      createElement: () => ({
        dataset: {}, style: {}, children: [], appendChild() {}, remove() {},
        addEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {} }
      }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
      createTreeWalker: () => ({ nextNode: () => null })
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.CSS = { escape: (s) => s };

  const modules = [];
  sandbox.window.__ModuleLoader__ = { load: ({ id, factory }) => modules.push({ id, factory }) };

  const ReactStub = {
    createElement: (t, p, ...c) => ({ type: t, props: p, children: c }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect() {}, useLayoutEffect() {}, useRef: () => ({ current: null }),
    useCallback: (f) => f, useMemo: (f) => f(), useReducer: (r, i) => [i, () => {}],
    memo: (f) => f, Fragment: Symbol('F'), Component: class { constructor(p) { this.props = p; } }
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  sandbox.require = (spec) => {
    if (spec === 'react') return ReactStub;
    if (spec === 'react/jsx-runtime') return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: Symbol('F') };
    if (spec === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
      return { Modal: function Modal() {}, Button: function Button() {} };
    }
    return {};
  };

  new Script(readFileSync(join(pluginDir, 'client.js'), 'utf-8'), { filename: 'client.js' })
    .runInContext(createContext(sandbox), { filename: 'client.js' });

  const mod = modules.find((m) => m.id === 'dsh-better-uiux').factory(sandbox.require);
  mod.apply({
    effect(fn) { try { fn(); } catch {} },
    locale: { register: () => () => {}, bind: () => (k) => k },
    slots: { inject: (n, cb) => cb(), register: () => () => {} },
    inject(services, cb) { cb({ sessions: { list: { getSnapshot: () => null } } }); },
    logger: { info() {}, warn() {}, error() {} }
  });

  return { internals: sandbox.__DSH_BETTER_UIUX__, configured };
}

const jobs = [
  { id: 'pwsh-1', kind: 'pwsh', command: '1..40 | ForEach-Object { "a" }', status: 'completed' },
  { id: 'pwsh-2', kind: 'pwsh', command: 'Get-ChildItem -Recurse', status: 'running' }
];

console.log('dsh-better-uiux — card job resolution\n');

const { internals, configured } = build(jobs);
check('resolveCardJobId is exported for diagnosis', typeof internals.resolveCardJobId === 'function');

// 1. The card itself names the job: cheapest path, must not touch the network.
{
  const card = makeCard({ jobId: 'pwsh-9' });
  const result = await internals.resolveCardJobId(card, { jobId: 'pwsh-9', callId: 'c1' });
  check('card dataset wins', result.jobId === 'pwsh-9' && result.source === 'card', JSON.stringify(result));
}

// 2. THE BUG: the card cannot be parsed. Fall back to the job store by command.
{
  const card = makeCard({ inText: 'not json at all', command: '1..40 | ForEach-Object { "a" }' });
  const result = await internals.resolveCardJobId(card, { jobId: null, callId: 'c2' });
  check(
    'unparseable card resolves through the job store',
    result.jobId === 'pwsh-1',
    `${JSON.stringify(result)} — this is the path that used to do nothing`
  );
  check('the store was actually consulted', configured.some((u) => u.includes('/api/better-uiux/jobs')), configured.join(', '));
}

// 3. A unique live job is unambiguous even when nothing else matches.
{
  const card = makeCard({ command: 'totally unrelated command text' });
  const result = await internals.resolveCardJobId(card, { jobId: null, callId: 'c3' });
  check('a single live job is used', result.jobId === 'pwsh-2', JSON.stringify(result));
}

// 4. Two live jobs and no command match: refuse rather than guess wrong.
{
  const twoLive = build([
    { id: 'j-a', kind: 'pwsh', command: 'aaa', status: 'running' },
    { id: 'j-b', kind: 'pwsh', command: 'bbb', status: 'running' }
  ]);
  const card = makeCard({ command: 'no match anywhere' });
  const result = await twoLive.internals.resolveCardJobId(card, { jobId: null, callId: 'c4' });
  check('ambiguity resolves to nothing, never to a wrong job', result.jobId === null, JSON.stringify(result));
  check('and it is reported as unresolved', result.source === 'unresolved', result.source);
}

// 5. Empty store: nothing to find, still no throw.
{
  const none = build([]);
  const result = await none.internals.resolveCardJobId(makeCard({}), { jobId: null, callId: null });
  check('empty store yields null without throwing', result.jobId === null && result.source === 'unresolved');
}

// 6. `/api/better-uiux/jobs` is filtered by command presence (native list parity).
{
  const withGap = build([
    { id: 'j-buffer', kind: 'pwsh', command: '', status: 'completed' },
    { id: 'j-real', kind: 'pwsh', command: 'real command here', status: 'running' }
  ]);
  const result = await withGap.internals.resolveCardJobId(makeCard({}), { jobId: null, callId: 'c6' });
  check('a job with no command is never chosen', result.jobId !== 'j-buffer', JSON.stringify(result));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exitCode = 1;
} else {
  console.log('card job resolution ok');
}
