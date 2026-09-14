// Dump every slot registration the client bundle makes, with the definition
// fields verbatim. Used to eyeball the ledger against the documented contract.
//
// Usage:  node tests/dump-registrations.mjs
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const registrations = [];
const injected = [];
const effects = [];

const ReactStub = {
  useReducer: () => [0, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useState: (v) => [v, () => {}],
  useCallback: (f) => f,
  useMemo: (f) => f(),
  useLayoutEffect: () => {},
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment')
};

const ctx = {
  effect(fn, label) {
    effects.push(label);
    try {
      fn();
    } catch (error) {
      effects.push(`THREW: ${label}: ${error.message}`);
    }
  },
  locale: { register: () => () => {}, bind: () => (key) => key },
  slots: {
    inject(name, cb) {
      injected.push(name);
      try {
        cb();
      } catch (error) {
        injected.push(`THREW on inject('${name}'): ${error.message}`);
      }
    },
    register(def) {
      registrations.push(def);
      return () => {};
    }
  },
  inject(services, cb) {
    injected.push(`services: ${services.join(',')}`);
    try {
      cb({ sessions: {} });
    } catch (error) {
      injected.push(`THREW on inject(${services.join(',')}): ${error.message}`);
    }
  },
  logger: { info() {}, warn() {}, error() {} }
};

const window = {
  __ModuleLoader__: { load() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: async () => ({ ok: true, json: async () => ({ features: {}, css: '' }) }),
  document: undefined
};
window.window = window;

const documentStub = {
  head: { appendChild() {}, lastElementChild: null },
  body: { appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ dataset: {}, style: {}, set textContent(_) {}, appendChild() {}, remove() {}, addEventListener() {} }),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  createTreeWalker: () => ({ nextNode: () => null })
};
window.document = documentStub;

const context = createContext({
  window,
  document: documentStub,
  globalThis: window,
  navigator: { clipboard: {} },
  MutationObserver: class { observe() {} disconnect() {} },
  NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
  requestAnimationFrame: (fn) => fn(),
  console: { log() {}, info() {}, warn() {}, error() {} },
  Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, Map, Set, Symbol, Error, RegExp,
  parseInt, parseFloat, isNaN, encodeURIComponent,
  setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
  setInterval: window.setInterval, clearInterval: window.clearInterval,
  fetch: window.fetch
});

function requireStub(spec) {
  if (spec === 'react') return ReactStub;
  if (spec === 'react/jsx-runtime') {
    const jsx = (type, props, key) => ({ type, props: { ...(props ?? {}), ...(key === undefined ? {} : { key }) }, children: [] });
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: Symbol('Fragment') };
  }
  if (spec === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: undefined, StateDot: undefined };
  return {};
}

const source = readFileSync(join(pluginDir, 'client.js'), 'utf-8');

// Capture the loader registrations so each module can be applied separately.
const modules = new Map();
const loaderWindow = { ...window, __ModuleLoader__: { load({ id, factory }) { modules.set(id, factory); } } };
loaderWindow.window = loaderWindow;
loaderWindow.document = documentStub;
loaderWindow.require = requireStub;
const loaderContext = createContext(loaderWindow);
new Script(source, { filename: 'client.js' }).runInContext(loaderContext, { filename: 'client.js' });

console.log('modules registered by the bundle:');
for (const id of modules.keys()) console.log(`  - ${id}`);

for (const [id, factory] of modules) {
  console.log(`\n=== applying ${id} ===`);
  const before = registrations.length;
  const mod = factory(requireStub);
  console.log(`exports: ${Object.keys(mod).join(', ')}`);
  // The live module expects the shared global; publish a stub so it can read it.
  if (id !== 'dsh-better-uiux') {
    loaderWindow.__DSH_BETTER_UIUX__ = {
      featureOn: () => false,
      onFeatures: () => () => {},
      getConfig: () => ({ features: {}, css: '' })
    };
  }
  try {
    mod.apply(ctx);
  } catch (error) {
    console.error(`  apply() THREW: ${error.message}`);
  }
  console.log(`  registrations added: ${registrations.length - before}`);
}

console.log('\n=== slot registrations ===');
for (const def of registrations) {
  console.log(`\nname=${def.name}  id=${def.id ?? '-'}  key=${def.key ?? '-'}  order=${def.order ?? '-'}  priority=${def.priority ?? '-'}  locale=${def.locale ?? '-'}`);
  if (def.children) console.log(`  children: ${JSON.stringify(def.children)}`);
  if (def.select) console.log(`  select: ${def.select.toString().slice(0, 80)}`);
  if (def.inject) console.log(`  inject: ${typeof def.inject}`);
  console.log(`  component: ${typeof def.component === 'function' ? def.component.name || '(anonymous)' : def.component === undefined ? 'MISSING' : typeof def.component}`);
}

console.log('\n=== slot injections (declaration waits) ===');
for (const entry of injected) console.log(`  ${entry}`);
console.log('\n=== effects ===');
for (const entry of effects) console.log(`  ${entry}`);
