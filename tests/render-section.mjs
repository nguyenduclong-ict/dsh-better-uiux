// Renders the plugin's Settings section with the DSH app's own React, using the
// props kit the slot renderer would hand it. This is the fastest way to see
// whether the component throws (which the shell turns into an empty crash div)
// and what it produces when it does not.
//
// Usage:  node tests/render-section.mjs

import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dshApp = 'C:/Users/ADMIN/AppData/Local/Programs/DSH Desktop/resources/app';
const requireFromDsh = createRequire(`${dshApp}/package.json`);
const React = requireFromDsh('react');
const ReactDOMServer = requireFromDsh('react-dom/server');

console.log(`react ${React.version}`);

// ---------------------------------------------------------------------------
// Load the bundle and collect the section component.
// ---------------------------------------------------------------------------

const registered = [];

const sandbox = {
  console,
  Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, Map, Set, Symbol, Error, RegExp,
  parseInt, parseFloat, isNaN, encodeURIComponent,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: (fn) => fn(),
  navigator: { clipboard: {} },
  MutationObserver: class { observe() {} disconnect() {} },
  NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ features: { liveTerminal: false, customCss: false, editMessage: false }, css: '' }) }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: {
    head: { appendChild() {}, lastElementChild: null },
    body: { appendChild() {} },
    getElementById: () => null,
    createElement: () => ({ dataset: {}, style: {}, appendChild() {}, remove() {}, addEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {} } }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    createTreeWalker: () => ({ nextNode: () => null })
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.require = (spec) => {
  if (spec === 'react') return React;
  if (spec === 'react/jsx-runtime') return requireFromDsh('react/jsx-runtime');
  if (spec === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return {};
  return {};
};
sandbox.window.__ModuleLoader__ = {
  load({ id, factory }) {
    registered.push({ id, factory });
  }
};

const source = readFileSync(join(pluginDir, 'client.js'), 'utf-8');
new Script(source, { filename: 'client.js' }).runInContext(createContext(sandbox), { filename: 'client.js' });

const core = registered.find((entry) => entry.id === 'dsh-better-uiux');
if (core === undefined) throw new Error('core module did not register');

const mod = core.factory(sandbox.require);

// ---------------------------------------------------------------------------
// Apply against a slot context that captures the component.
// ---------------------------------------------------------------------------

const captured = [];
const effects = [];
/** The dictionaries exactly as the plugin passes them to the locale runtime. */
let dictionaries = null;

const ctx = {
  effect(fn, label) {
    effects.push(label);
    try { fn(); } catch (error) { effects.push(`THREW ${label}: ${error.message}`); }
  },
  locale: {
    register(ns, dicts) {
      dictionaries = { ns, dicts };
      captured.push({ kind: 'locale', ns, locales: Object.keys(dicts) });
      return () => {};
    },
    bind: () => REAL_TRANSLATOR
  },
  slots: {
    inject(name, cb) { try { cb(); } catch (error) { captured.push({ kind: 'inject-threw', name, message: error.message }); } },
    register(def, component) {
      captured.push({ kind: 'register', name: def.name, id: def.id, def, component });
      return () => {};
    }
  },
  inject(services, cb) { try { cb({ sessions: {} }); } catch (error) { captured.push({ kind: 'services-threw', message: error.message }); } },
  logger: { info() {}, warn() {}, error() {} }
};

/**
 * The REAL interpolation contract, copied from `LocaleRuntime.translate` in
 * @deepseek-ai/dsh-client-locale: the dictionary value must be a STRING and
 * `{name}` placeholders are substituted from `params`. A non-string value (a
 * function, say) makes `template.replace` throw — which is exactly the bug this
 * shim exists to catch.
 */
function lookup(ns, key) {
  const table = dictionaries?.dicts ?? {};
  for (const locale of ['en', 'zh', 'vi']) {
    const value = table[locale]?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function REAL_TRANSLATOR(key, params) {
  const template = lookup(dictionaries?.ns, key) ?? key;
  if (typeof template !== 'string') {
    throw new TypeError(`template.replace is not a function (locale key "${key}" is a ${typeof template})`);
  }
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

mod.apply(ctx);

const section = captured.find((entry) => entry.kind === 'register' && entry.name === 'settings.section');
if (section === undefined) throw new Error('settings.section was not registered');
if (typeof section.component !== 'function') throw new Error(`section component is ${typeof section.component}`);

console.log(`\nlocale keys (en): ${Object.keys(dictionaries?.dicts?.en ?? {}).length}`);
console.log(`section component: ${section.component.name}`);

// ---------------------------------------------------------------------------
// Static dictionary contract: the runtime calls `template.replace`, so every
// value MUST be a string, and every locale must define the same key set.
// ---------------------------------------------------------------------------

const locales = Object.keys(dictionaries.dicts);
const reference = Object.keys(dictionaries.dicts.en).sort();
let dictionaryProblems = 0;

for (const locale of locales) {
  const table = dictionaries.dicts[locale];
  const nonString = Object.entries(table).filter(([, value]) => typeof value !== 'string');
  const keys = Object.keys(table).sort();
  if (nonString.length > 0) {
    dictionaryProblems += 1;
    console.error(`  FAIL ${locale}: non-string values -> ${nonString.map(([k, v]) => `${k} (${typeof v})`).join(', ')}`);
  }
  if (keys.join('|') !== reference.join('|')) {
    dictionaryProblems += 1;
    const missing = reference.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !reference.includes(k));
    console.error(`  FAIL ${locale}: key set differs (missing: ${missing.join(', ') || '-'} | extra: ${extra.join(', ') || '-'})`);
  }
}
if (dictionaryProblems === 0) {
  console.log(`  ok   all ${locales.length} locales: ${reference.length} string values, identical key sets`);
} else {
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Render the way the slot renderer would.
// ---------------------------------------------------------------------------

const kit = {
  t: REAL_TRANSLATOR,
  renderSlot: (slot, ownerProps, opts) => React.createElement('div', { 'data-slot': slot }, `[slot ${slot}]`)
};

console.log('\n--- render (initial state) ---');
try {
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(section.component, kit));
  console.log(`rendered ${html.length} chars`);
  if (/render error/.test(html)) {
    console.error('FAIL: the section rendered its error face');
    console.error(html.slice(0, 900));
    process.exitCode = 1;
  } else {
    console.log('  ok   section rendered its real content');
    // Every user-visible string must be resolved, never a raw locale key.
    const suspicious = [...html.matchAll(/>([a-zA-Z][A-Za-z0-9_]{3,})</g)]
      .map((match) => match[1])
      .filter((text) => reference.includes(text));
    if (suspicious.length > 0) {
      console.error(`FAIL: unresolved locale keys rendered: ${suspicious.join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log('  ok   no raw locale keys leaked into the markup');
    }

    // Defaults: liveTerminal and customCss open ON. Edit message is temporarily
    // hidden (EDIT_MESSAGE_HIDDEN), so it renders no switch at all — neither as a
    // row nor as a note.
    const switches = (html.match(/role="switch"/g) ?? []).length;
    const onSwitches = (html.match(/role="switch"[^>]*aria-checked="true"/g) ?? []).length;
    const offSwitches = (html.match(/role="switch"[^>]*aria-checked="false"/g) ?? []).length;
    if (switches !== 2) {
      console.error(`FAIL: expected 2 switches, found ${switches}`);
      process.exitCode = 1;
    } else if (onSwitches !== 2 || offSwitches !== 0) {
      console.error(`FAIL: expected 2 on / 0 off by default, found ${onSwitches} on and ${offSwitches} off`);
      process.exitCode = 1;
    } else {
      console.log('  ok   2 switches: 2 on (live, css) by default');
    }

    if (/Edit message|编辑消息|Sửa tin nhắn/.test(html)) {
      console.error('FAIL: the hidden Edit message feature still renders in the pane');
      process.exitCode = 1;
    } else {
      console.log('  ok   hidden Edit message feature renders nothing');
    }

    if (!/2\/2 enabled/.test(html)) {
      console.error('FAIL: the "{on}/{total} enabled" counter did not interpolate to 2/2');
      process.exitCode = 1;
    } else {
      console.log('  ok   counter interpolated ({on}/{total} = 2/2)');
    }

    console.log(html.slice(0, 700));
  }
} catch (error) {
  console.error(`RENDER THREW: ${error.constructor.name}: ${error.message}`);
  console.error(error.stack?.split('\n').slice(0, 12).join('\n'));
  process.exitCode = 1;
}

console.log('\n--- captured events ---');
for (const entry of captured) {
  if (entry.kind === 'register') console.log(`  register ${entry.name} id=${entry.id ?? '-'}`);
  else console.log(`  ${JSON.stringify(entry)}`);
}
console.log('\n--- effects ---');
for (const label of effects) console.log(`  ${label}`);
