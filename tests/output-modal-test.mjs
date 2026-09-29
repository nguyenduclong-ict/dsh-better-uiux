// The Output modal, rendered for real.
//
// THE BUG THIS EXISTS FOR: the running duration was computed as
// `Date.now() - startedAt` at RENDER time, and the modal's 300ms host poll
// changes no state at all while a job prints nothing new — no new output, same
// status, same startedAt. So the elapsed time stayed at whatever `Date.now()`
// said when the modal opened and looked frozen for a quiet job. A regex over
// the source cannot see that; this test drives the real component in a DOM,
// with a host stub that answers every poll with identical fields, and asserts
// the reading advances on its own.
//
// It also pins the command block: a multi-line command renders verbatim and is
// capped at three lines with its own scroller, the way DSH's own TerminalBlock
// banner scrolls a long command instead of pushing the output off screen.
//
// Usage:  node tests/output-modal-test.mjs
//
// Needs the DSH install's own react / react-dom / jsdom, so it SKIPS (exit 0)
// where that tree is not present rather than failing a checkout that cannot
// have it.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

const section = (title) => console.log(`\n${title}`);

// ---------------------------------------------------------------------------
// DSH's own React, react-dom and jsdom (the unpacked tree carries node_modules).
// ---------------------------------------------------------------------------

const dshApp = process.env.DSH_APP_UNPACKED
  ?? 'C:/Users/ADMIN/AppData/Local/Programs/DSH Desktop/resources/app.asar.unpacked';

let React, ReactDOMClient, act, JSDOM;
try {
  const requireFromDsh = createRequire(`${dshApp}/index.js`);
  React = requireFromDsh('react');
  ReactDOMClient = requireFromDsh('react-dom/client');
  act = React.act ?? requireFromDsh('react-dom/test-utils').act;
  ({ JSDOM } = requireFromDsh('jsdom'));
} catch (error) {
  console.log(`SKIP  output modal test — DSH's react/jsdom are not reachable from ${dshApp}`);
  console.log(`      ${error.message}`);
  process.exit(0);
}

console.log(`dsh-better-uiux output modal (react ${React.version})`);

// ---------------------------------------------------------------------------
// A DOM, plus a host that never changes its answer.
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const startedAt = Date.now() - 65000;

/** A running job whose output the modal already has: every poll is a no-op. */
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    found: true,
    active: true,
    status: 'running',
    jobId: 'job-1',
    command: 'pwsh ...',
    startedAt,
    finishedAt: 0,
    output: 'first line only'
  })
});

// ---------------------------------------------------------------------------
// Load the live half through its own module loader, as the shell does.
// ---------------------------------------------------------------------------

let factory = null;
dom.window.__ModuleLoader__ = { load({ factory: registered }) { factory = registered; } };

const requireShim = (spec) => {
  if (spec === 'react') return React;
  if (spec === 'react/jsx-runtime') return createRequire(`${dshApp}/index.js`)('react/jsx-runtime');
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      // The real Modal renders `footer` as its own region; the stub has to keep
      // that, or the footer assertions below would pass on a missing footer.
      Modal: ({ children, footer }) => React.createElement('div', { 'data-modal': 'stub' }, children, footer),
      StateDot: ({ state }) => React.createElement('i', { 'data-state': state })
    };
  }
  return {};
};

const live = readFileSync(join(pluginDir, 'live-terminal.js'), 'utf-8');
new Function('window', live)(dom.window); // registers the factory
const internals = factory(requireShim).__internals;

section('1. the module exposes the modal');
check('internals carry OutputModal and openOutputModal', !!internals?.OutputModal && !!internals?.openOutputModal);

const command = 'pwsh -NoProfile -Command "line one\nline two is quite a bit longer\nline three\nline four\nline five"';
internals.openOutputModal({ jobId: 'job-1', command, status: 'running', startedAt, finishedAt: 0 });

const container = document.createElement('div');
document.body.appendChild(container);
const root = ReactDOMClient.createRoot(container);
await act(async () => { root.render(React.createElement(internals.OutputModal)); });
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

const commandEl = container.querySelector('.dsh-live-modal-command');
const durationEl = container.querySelector('.dsh-live-modal-duration');
const buttons = [...container.querySelectorAll('button')].map((button) => button.textContent);

section('2. the command is a multi-line block');
check('the command block renders', !!commandEl);
check('every newline survives', (commandEl?.textContent ?? '').split('\n').length === 5, JSON.stringify(commandEl?.textContent));
check('the command is the target command verbatim', commandEl?.textContent === command);
check('the stylesheet caps it at three 18px lines', /\.dsh-live-modal-command\s*\{[^}]*max-height:\s*54px/.test(live));
check('the stylesheet scrolls it past the cap', /\.dsh-live-modal-command\s*\{[^}]*overflow-y:\s*auto/.test(live));
check('the stylesheet wraps instead of ellipsizing', /\.dsh-live-modal-command\s*\{[^}]*white-space:\s*pre-wrap/.test(live));
check('the meta row top-aligns the dot with the first line', /\.dsh-live-modal-meta\s*\{[^}]*align-items:\s*flex-start/.test(live));

section('3. the running duration keeps moving');
check('duration renders on open', durationEl?.textContent === '1m 5s', durationEl?.textContent);
check('the output pane shows the host text', container.querySelector('.dsh-live-modal-output')?.textContent.includes('first line only'));

// Nothing below touches the host: if the reading moves, the ticker moved it.
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
check('duration advances with no new output', durationEl?.textContent === '1m 6s' || durationEl?.textContent === '1m 7s', durationEl?.textContent);
check('the ticker is one second and runs only while live',
  /setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/.test(live) && /if \(!active \|\| !timing\.startedAt\) return undefined;/.test(live));
check('duration reads the sampled clock, not Date.now() at render',
  /\(timing\.finishedAt \|\| now\) - timing\.startedAt/.test(live));

section('4. the footer is still Copy + Stop job');
check('a running job offers Stop job', buttons.join(' | ') === 'Copy | Stop job', buttons.join(' | '));

await act(async () => { root.unmount(); });

console.log(`\n${checks} checks, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
