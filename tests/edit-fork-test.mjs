// Edit-and-resend: the FORK path must actually be taken.
//
// THE BUG THIS EXISTS FOR: `sessions.fork()` resolves to the child id STRING
// (and throws on failure), but the caller read it as a `{ok, value}` envelope.
// So `forked?.ok === true` was always false, every edit threw, and every edit
// silently fell through to "send into the current session" — which appends the
// message to the queue instead of replacing anything. The user-visible symptom
// was exactly "editing adds a message to the queue".
//
// This drives the real factory, stubs the sessions service, and asserts which
// path ran.
//
// Usage:  node tests/edit-fork-test.mjs
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

/** Mirror of the host's SessionForkError, so the code's catch paths are real. */
class SessionForkError extends Error {
  constructor(rpcError, sourceSessionId) {
    super(`session fork failed: ${rpcError.code}: ${rpcError.message}`);
    this.name = 'SessionForkError';
    this.rpcError = rpcError;
    this.sourceSessionId = sourceSessionId;
  }
}

/**
 * Build the plugin with a scriptable sessions service.
 * @param {object} options
 * @param {'string'|'envelope'|'throw'|'empty'} options.forkShape - how fork behaves.
 * @param {'ok'|'throw'} options.deleteShape - how delete behaves.
 */
function build({ forkShape = 'string', deleteShape = 'ok' } = {}) {
  const calls = {
    fork: [],
    open: [],
    binding: [],
    childPrompts: [],
    currentPrompts: [],
    deleted: [],
    /** Ordered event log, to assert that the view moves before the delete. */
    order: []
  };

  const childSession = {
    prompt: async (content, mode) => {
      calls.childPrompts.push({ content, mode });
      calls.order.push('prompt:child');
      return { ok: true };
    }
  };
  const currentSession = {
    prompt: async (content, mode) => {
      calls.currentPrompts.push({ content, mode });
      calls.order.push('prompt:current');
      return { ok: true };
    }
  };

  const sessions = {
    fork: async (opts) => {
      calls.fork.push(opts);
      calls.order.push('fork');
      if (forkShape === 'throw') throw new SessionForkError({ code: 'turn-open', message: 'turn is open' }, opts.sessionId);
      if (forkShape === 'empty') return undefined;
      if (forkShape === 'envelope') return { ok: true, value: { sessionId: 'child-1' } };
      return 'child-1'; // the real shape: the child id string
    },
    open: (id) => {
      calls.open.push(id);
      calls.order.push(`open:${id}`);
    },
    delete: async (id) => {
      calls.deleted.push(id);
      calls.order.push(`delete:${id}`);
      if (deleteShape === 'throw') {
        const error = new Error('session delete failed: session-busy: the session is running');
        error.rpcError = { code: 'session-busy', message: 'the session is running' };
        throw error;
      }
    },
    binding: (id) => {
      calls.binding.push(id);
      if (id === 'child-1') return { sessionId: id, session: childSession, ctx: {} };
      return { sessionId: id, session: currentSession, ctx: {} };
    },
    list: { getSnapshot: () => ({ selectedId: 'parent-1', ids: ['parent-1', 'child-1'], byId: {} }) }
  };

  const ReactStub = {
    useReducer: () => [0, () => {}], useEffect() {}, useRef: () => ({ current: null }),
    useState: (v) => [v, () => {}], useCallback: (f) => f, useMemo: (f) => f(), useLayoutEffect() {},
    createElement: (t, p, ...c) => ({ type: t, props: p, children: c }),
    Component: class { constructor(p) { this.props = p; this.state = {}; } },
    Fragment: Symbol('F')
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });

  const storage = new Map();
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, Map, Set, Symbol, Error, RegExp,
    parseInt, parseFloat, isNaN, encodeURIComponent,
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: (fn) => { fn(); return 0; },
    navigator: { clipboard: {} },
    MutationObserver: class { observe() {} disconnect() {} },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ features: { liveTerminal: true, customCss: true, editMessage: true }, css: '' })
    }),
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    document: {
      head: { appendChild() {}, lastElementChild: null },
      body: { appendChild() {} },
      getElementById: () => null,
      createElement: () => ({ dataset: {}, style: {}, children: [], appendChild() {}, remove() {}, addEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {} } }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
      createTreeWalker: () => ({ nextNode: () => null })
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const modules = [];
  sandbox.window.__ModuleLoader__ = { load: ({ id, factory }) => modules.push({ id, factory }) };
  sandbox.require = (spec) => {
    if (spec === 'react') return ReactStub;
    if (spec === 'react/jsx-runtime') return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: Symbol('F') };
    if (spec === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
    return {};
  };

  new Script(readFileSync(join(pluginDir, 'client.js'), 'utf-8'), { filename: 'client.js' })
    .runInContext(createContext(sandbox), { filename: 'client.js' });

  const core = modules.find((m) => m.id === 'dsh-better-uiux');
  const mod = core.factory(sandbox.require);

  mod.apply({
    effect(fn) { try { fn(); } catch {} },
    locale: { register: () => () => {}, bind: () => (k) => k },
    slots: { inject: (n, cb) => cb(), register: () => () => {} },
    inject(services, cb) {
      const bag = { sessions };
      if (services.includes('conversation')) bag.conversation = { input: { for: () => null } };
      cb(bag);
    },
    logger: { info() {}, warn() {}, error() {} }
  });

  return { internals: mod.__internals, calls, SessionForkError, sandbox };
}

/**
 * Replay the exact call the modal's save button makes.
 *
 * `resendEditedMessage` is exported on `__internals` so this test drives the real
 * implementation rather than a copy of it.
 */
function seedAnchors(internals, entries) {
  for (const [turn, seq] of entries) internals.turnEndSeq.set(turn, seq);
}
void seedAnchors;

console.log('dsh-better-uiux edit-and-resend: the fork path\n');

console.log('1. a successful fork goes to the CHILD, never the current session');
{
  const { internals, calls } = build({ forkShape: 'string' });
  internals.turnEndSeq.set(1, 10);
  internals.turnEndSeq.set(2, 20);

  // A fork that resolves legitimately must not throw. This used to throw "fork
  // failed" for every edit, because the child id string was read as an envelope.
  let outcome = null;
  let thrown = null;
  try {
    outcome = await internals.resendEditedMessage('parent-1', 2, 'rewritten message');
  } catch (error) {
    thrown = error;
  }

  check('a legitimate fork does not throw', thrown === null, String(thrown));
  check('returns the fork child id', outcome?.childId === 'child-1', JSON.stringify(outcome));
  check('fork was called once', calls.fork.length === 1, `called ${calls.fork.length}`);
  check('fork used the PREVIOUS turn anchor (turn 2 -> seq 10)', calls.fork[0]?.atSeq === 10, String(calls.fork[0]?.atSeq));
  check('fork targeted the on-screen session', calls.fork[0]?.sessionId === 'parent-1');
  check('fork asked for a title increase', calls.fork[0]?.increaseTitle === true);
  check('the child was opened', calls.open.length === 1 && calls.open[0] === 'child-1', JSON.stringify(calls.open));
  check('the child received the prompt', calls.childPrompts.length === 1, `child=${calls.childPrompts.length}`);
  check('the rewritten text was sent', calls.childPrompts[0]?.content?.[0]?.text === 'rewritten message');
  check('it was queued', calls.childPrompts[0]?.mode === 'queue');
  check('the CURRENT session got NOTHING (the old bug appended here)', calls.currentPrompts.length === 0, JSON.stringify(calls.currentPrompts));
  check('the original was NOT deleted by default', calls.deleted.length === 0, JSON.stringify(calls.deleted));
  check('the outcome reports it was not retired', outcome?.retired === false);
}

console.log('\n2. retireOriginal=true deletes the source, in the safe order');
{
  const { internals, calls } = build({ forkShape: 'string' });
  internals.turnEndSeq.set(1, 10);
  internals.turnEndSeq.set(2, 20);

  const outcome = await internals.resendEditedMessage('parent-1', 2, 'rewritten', true);

  check('the original session was deleted', calls.deleted.length === 1 && calls.deleted[0] === 'parent-1', JSON.stringify(calls.deleted));
  check('the outcome reports it was retired', outcome?.retired === true, JSON.stringify(outcome));
  check('no retire error', outcome?.retireError === null, String(outcome?.retireError));
  // The view must move to the branch BEFORE the old session disappears, otherwise
  // the UI is briefly pointing at a session that no longer exists.
  const forkAt = calls.order.indexOf('fork');
  const openAt = calls.order.indexOf('open:child-1');
  const promptAt = calls.order.indexOf('prompt:child');
  const deleteAt = calls.order.indexOf('delete:parent-1');
  check('order is fork -> open -> prompt -> delete', forkAt < openAt && openAt < promptAt && promptAt < deleteAt, calls.order.join(' -> '));
  check('the text reached the child before the delete', calls.childPrompts[0]?.content?.[0]?.text === 'rewritten');
}

console.log('\n3. a failed retire is a partial success, not a failed edit');
{
  const { internals, calls } = build({ forkShape: 'string', deleteShape: 'throw' });
  internals.turnEndSeq.set(1, 10);
  internals.turnEndSeq.set(2, 20);

  let outcome = null;
  let thrown = null;
  try {
    outcome = await internals.resendEditedMessage('parent-1', 2, 'rewritten', true);
  } catch (error) {
    thrown = error;
  }

  check('the call still resolves (the branch is live)', thrown === null, String(thrown));
  check('the text still reached the child', calls.childPrompts.length === 1);
  check('retired is false', outcome?.retired === false);
  check('the rpc error code is reported', outcome?.retireError === 'session-busy', String(outcome?.retireError));
}

console.log('\n4. the shape the code must accept (regression: envelope reading)');
{
  const { internals } = build({ forkShape: 'string' });
  const resolved = await internals.sessions.fork({ sessionId: 'parent-1', atSeq: 10 });
  check('fork resolves to a string id', typeof resolved === 'string', typeof resolved);
  check('it is NOT an {ok} envelope', resolved?.ok === undefined, JSON.stringify(resolved));

  // The exact expression that used to run, kept as an executable reminder.
  const oldReading = resolved?.ok === true ? resolved.value?.sessionId : null;
  check('the old envelope reading yields null -> would fall back', oldReading === null, String(oldReading));
  const newReading = typeof resolved === 'string' && resolved.length > 0;
  check('the new reading accepts it', newReading === true);
}

console.log('\n5. editing turn 1 has no completed turn before it -> throws');
{
  const { internals, calls } = build({ forkShape: 'string' });
  internals.turnEndSeq.set(1, 10);
  let caught = null;
  try {
    await internals.resendEditedMessage('parent-1', 1, 'text');
  } catch (error) {
    caught = error;
  }
  check('it throws instead of guessing', caught !== null, 'no throw');
  check('no fork was attempted', calls.fork.length === 0, `fork called ${calls.fork.length} times`);
  check('the current session was not touched', calls.currentPrompts.length === 0);
  check('nothing was deleted', calls.deleted.length === 0);
}

console.log('\n5b. a MISSING turn N-1 anchor falls back to the nearest one below');
{
  // Reported in the wild as: "no completed turn before the edited message".
  // The turnTail chain only reports for turns that rendered a tail in this page
  // session, so turn N-1 can be absent while an earlier turn is known.
  const { internals, calls } = build({ forkShape: 'string' });
  internals.turnEndSeq.set(1, 10); // turn 2 missing entirely
  internals.turnEndSeq.set(3, 30);

  const outcome = await internals.resendEditedMessage('parent-1', 3, 'rewritten');
  check('it forks instead of failing', calls.fork.length === 1, `fork called ${calls.fork.length} times`);
  check('anchor is the nearest known turn below the edit', calls.fork[0]?.atSeq === 10, String(calls.fork[0]?.atSeq));
  check('it still branched', outcome?.childId === 'child-1');
  check('the current session got nothing', calls.currentPrompts.length === 0);
}

console.log('\n5c. a LATER anchor is never chosen (a too-late cut keeps the old text)');
{
  const { internals, calls } = build({ forkShape: 'string' });
  internals.turnEndSeq.set(3, 30);
  internals.turnEndSeq.set(7, 70); // only a later turn besides an earlier one
  await internals.resendEditedMessage('parent-1', 5, 'rewritten');
  check('it picked the anchor below, not above', calls.fork[0]?.atSeq === 30, String(calls.fork[0]?.atSeq));
  check('resolveForkAnchor agrees', internals.resolveForkAnchor(5) === 30, String(internals.resolveForkAnchor(5)));
}

console.log('\n5d. no anchors at all -> the error says the probe has not run');
{
  const { internals } = build({ forkShape: 'string' });
  let caught = null;
  try {
    await internals.resendEditedMessage('parent-1', 3, 'text');
  } catch (error) {
    caught = error;
  }
  check('it throws', caught !== null);
  check('the message names the anchor turn', /turn 2/.test(String(caught?.message)), String(caught?.message));
  check('the message says the probe has not run', /probe has not run/.test(String(caught?.message)), String(caught?.message));
}

console.log('\n5e. the anchor state is inspectable for diagnosis');
{
  const { internals, sandbox } = build({ forkShape: 'string' });
  internals.turnEndSeq.set(1, 10);
  internals.turnEndSeq.set(2, 20);
  check('anchorState exists', typeof internals.anchorState === 'function');
  const state = internals.anchorState();
  check('it reports the anchors', JSON.stringify(state.anchors) === JSON.stringify({ 1: 10, 2: 20 }), JSON.stringify(state.anchors));
  check('it reports whether the editor is running', typeof state.editorRunning === 'boolean');
  check('resolveForkAnchor is exported', typeof internals.resolveForkAnchor === 'function');
  // The global is what makes this reachable from the DevTools console, so assert
  // it on the PLUGIN's global (its sandbox), not the test process's own.
  check('it is also on the plugin global for DevTools', sandbox.__DSH_BETTER_UIUX__ === internals);
  check('the global exposes anchorState()', typeof sandbox.__DSH_BETTER_UIUX__?.anchorState === 'function');
}

console.log('\n6. a real fork failure throws SessionForkError (so the fallback can fire)');
{
  const { internals, SessionForkError, calls } = build({ forkShape: 'throw' });
  internals.turnEndSeq.set(1, 10);
  internals.turnEndSeq.set(2, 20);
  let caught = null;
  try {
    await internals.resendEditedMessage('parent-1', 2, 'text');
  } catch (error) {
    caught = error;
  }
  check('a SessionForkError is raised', caught instanceof SessionForkError, String(caught));
  check('the source session is recorded', caught?.sourceSessionId === 'parent-1');
  check('the rpc code is reachable for reporting', caught?.rpcError?.code === 'turn-open');
  check('nothing was opened', calls.open.length === 0);
  check('nothing was prompted anywhere', calls.childPrompts.length + calls.currentPrompts.length === 0);
  check('nothing was deleted', calls.deleted.length === 0);
}

console.log('\n7. the append helper is an explicit path, never an automatic fallback');
{
  const { internals, calls } = build({ forkShape: 'string' });
  await internals.resendInCurrentSession('parent-1', 'fallback text');
  check('it prompts the CURRENT session', calls.currentPrompts.length === 1, JSON.stringify(calls.currentPrompts));
  check('it does not fork', calls.fork.length === 0);
  check('it does not open anything', calls.open.length === 0);
  check('it does not delete anything', calls.deleted.length === 0);
}

console.log('\n8. a failed branch changes NOTHING (no silent append)');
{
  // The bug this guards: a failed branch used to be caught and turned into
  // "append the message to the current session", so an edit looked like it had
  // been added as a new message. The behaviour is now: report, change nothing.
  const { internals, calls } = build({ forkShape: 'throw' });
  internals.turnEndSeq.set(1, 10);
  internals.turnEndSeq.set(2, 20);

  let caught = null;
  try {
    await internals.resendEditedMessage('parent-1', 2, 'rewritten');
  } catch (error) {
    caught = error;
  }

  check('it throws rather than resolving', caught !== null);
  check('NOTHING was appended to the current session', calls.currentPrompts.length === 0, JSON.stringify(calls.currentPrompts));
  check('nothing was sent to a child either', calls.childPrompts.length === 0);
  check('nothing was opened', calls.open.length === 0);
  check('nothing was deleted', calls.deleted.length === 0);
  check('the reason is available as an rpc code', caught?.rpcError?.code === 'turn-open', String(caught?.rpcError?.code));
}

console.log('\n9. a missing anchor also appends nothing');
{
  const { internals, calls } = build({ forkShape: 'string' });
  let caught = null;
  try {
    await internals.resendEditedMessage('parent-1', 2, 'rewritten'); // no anchors seeded
  } catch (error) {
    caught = error;
  }
  check('it throws', caught !== null);
  check('nothing was appended', calls.currentPrompts.length === 0, JSON.stringify(calls.currentPrompts));
  check('no fork was attempted', calls.fork.length === 0);
  check('the message names the probe', /probe has not run/.test(String(caught?.message)), String(caught?.message));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exitCode = 1;
} else {
  console.log('edit fork ok');
}
