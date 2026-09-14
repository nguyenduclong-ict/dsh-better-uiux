// Builds the single client bundle this package ships.
//
// WHY A BUILD STEP AT ALL: the DSH client module loader composes ONE client
// bundle per package (`exports["./client"]`), and that single artifact is what the
// shell serves as `/plugins/<pkg>/client.js`. This plugin is genuinely two sources
// — the settings/config core and the live-terminal port — so they are combined
// here into that one artifact.
//
// WHY THEY ARE MERGED INTO ONE MODULE RATHER THAN REGISTERED AS TWO: the original
// version of this file concatenated both files, each registering its own module
// with `window.__ModuleLoader__.load`. That is wrong. The shell only runs
// `apply()` for a package's PRIMARY module, so the second registration was
// installed and never started:
//
//   __DSH_BETTER_UIUX__            -> object   (core applied)
//   __DSH_BETTER_UIUX__.liveState  -> undefined (live module NEVER applied)
//
// The live terminal therefore never injected a style tag or a single button while
// the host half captured its output perfectly. Both original plugins registered
// exactly ONE module each, which is why neither showed the problem.
//
// So `live-terminal.js` is no longer concatenated: its factory BODY is inlined
// into the core module's factory, and the core's `apply` calls it. One
// registration, one apply, one module table entry.
//
// Usage:  node build.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = dirname(fileURLToPath(import.meta.url));

const read = (file) => readFileSync(join(pluginDir, file), 'utf-8');

const core = read('core.js');
const live = read('live-terminal.js');

/**
 * Splice one occurrence of a multi-line marker, tolerating mixed LF/CRLF line
 * endings (the sources are not consistent) and failing loudly instead of silently
 * doing nothing.
 */
function splice(source, marker, replacement, label) {
  const pattern = marker
    .split('\n')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\r?\\n');
  const re = new RegExp(pattern, 'g');
  const hits = (source.match(re) ?? []).length;
  if (hits !== 1) {
    throw new Error(`build: marker "${label}" appears ${hits} time(s); expected exactly 1`);
  }
  return source.replace(re, () => replacement);
}

/** Index of a multi-line marker, or -1. Same line-ending tolerance as `splice`. */
function indexOf(source, marker) {
  const pattern = marker
    .split('\n')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\r?\\n');
  const re = new RegExp(pattern, 'g');
  const matches = [...source.matchAll(re)];
  if (matches.length > 1) {
    throw new Error(`build: marker appears ${matches.length} times; expected at most 1`);
  }
  return matches.length === 0 ? -1 : matches[0].index;
}

// ---------------------------------------------------------------------------
// 1. Extract the live-terminal factory BODY (dropping its own loader wrapper).
// ---------------------------------------------------------------------------
// NOTE the indentation: live-terminal.js registers at the TOP level of its file,
// so its wrapper is indented two spaces, not four.
const LIVE_START = [
  'window.__ModuleLoader__.load({',
  "  id: 'dsh-better-uiux/live-terminal',",
  '  factory: (require) => {',
  '    const module = { exports: {} };',
  '    const exports = module.exports;'
].join('\n');

const LIVE_END = '    return module.exports;\n  }\n});';

const liveStartAt = indexOf(live, LIVE_START);
if (liveStartAt === -1) throw new Error('build: could not find the live-terminal loader wrapper start');
const liveEndAt = indexOf(live, LIVE_END);
if (liveEndAt === -1) throw new Error('build: could not find the live-terminal loader wrapper end');
if (liveEndAt < liveStartAt) throw new Error('build: live-terminal wrapper markers are out of order');

// Slice past the marker text itself; measure the real matched length.
const startMatch = live.slice(liveStartAt).match(/^[\s\S]*?const exports = module\.exports;/);
if (startMatch === null) throw new Error('build: could not measure the wrapper start');
const bodyFrom = liveStartAt + startMatch[0].length;
const bodyTo = liveEndAt;
if (bodyTo <= bodyFrom) throw new Error('build: live-terminal wrapper body is empty');

// The wrapper body sits at four spaces of indentation, exactly the depth of the
// core factory's own locals, so it needs no re-indenting.
let liveBody = live.slice(bodyFrom, bodyTo);

// The body refers to `exports`; inside the core factory that name is taken by the
// core's own exports object, so rename every reference to keep the two apart.
const liveExportsBefore = (liveBody.match(/\bexports\b/g) ?? []).length;
liveBody = liveBody.replace(/\bexports\b/g, 'liveExports');
if (liveExportsBefore === 0) throw new Error('build: live-terminal body never touches `exports`');

// Both halves publish `__internals`, and the live half is inlined SECOND, so a
// plain assignment would REPLACE the core's internals with the live half's and
// silently delete `anchorState` plus the fork helpers. Merge instead.
const INTERNALS_ASSIGN = 'liveExports.__internals = {';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const internalsHits = (liveBody.match(new RegExp(escapeRe(INTERNALS_ASSIGN), 'g')) ?? []).length;
if (internalsHits !== 1) {
  throw new Error(`build: expected exactly 1 live __internals assignment, found ${internalsHits}`);
}
liveBody = liveBody.replace(INTERNALS_ASSIGN, 'Object.assign(exports.__internals, {');

// ...and the matching closing brace: the internals literal is the LAST statement in
// the live factory body, so it is the final `};` before the wrapper's `return`.
const internalsClose = /\n(\s*)\};\s*$/;
if (!internalsClose.test(liveBody)) {
  throw new Error('build: could not find the live __internals closing brace');
}
liveBody = liveBody.replace(internalsClose, '\n$1});\n');

const liveSection = [
  '',
  '  // ---------------------------------------------------------------------',
  '  // LIVE TERMINAL MODULE (inlined from live-terminal.js)',
  '  //',
  '  // Registered as its own module until it was discovered that the shell only',
  '  // runs apply() for a package\'s PRIMARY module: the second registration loaded',
  '  // and never started, so the whole feature was dead while the host half worked.',
  '  // Inlined here so there is exactly one module and one apply().',
  '  // ---------------------------------------------------------------------',
  '  const liveTerminalModule = (() => {',
  '    const liveExports = {};',
  liveBody.trimEnd(),
  '    return liveExports;',
  '  })();',
  ''
].join('\n');

// ---------------------------------------------------------------------------
// 2. Inline it, and expose it so the core's `apply` can start it.
// ---------------------------------------------------------------------------
const CORE_TAIL = '\n    return module.exports;';
let bundle = splice(core, CORE_TAIL, `${liveSection}\n    // Exposed so this module's apply() starts the live half in the same fibre.\n    exports.__liveTerminal = liveTerminalModule;${CORE_TAIL}`, 'core return');

// ---------------------------------------------------------------------------
// 3. Make the core's apply run the live half (last, after the core is set up).
// ---------------------------------------------------------------------------
const APPLY_TAIL = '      void loadFromHost();\n    }';
const APPLY_TAIL_WITH_LIVE = [
  '      void loadFromHost();',
  '',
  '      // The live terminal half runs LAST, in this same apply: the shell only',
  '      // applies a package\'s primary module, so nothing else would ever start it.',
  '      // It reads this module\'s published switches through globalThis.',
  '      try {',
  '        exports.__liveTerminal.apply(ctx);',
  '      } catch (error) {',
  "        console.warn('[better-uiux] live terminal module failed to start:', error);",
  '      }',
  '    }'
].join('\n');
bundle = splice(bundle, APPLY_TAIL, APPLY_TAIL_WITH_LIVE, 'core apply tail');

// ---------------------------------------------------------------------------
// 4. Verify the result is exactly one module, with the live half wired in.
// ---------------------------------------------------------------------------
const loads = (bundle.match(/window\.__ModuleLoader__\.load\(/g) ?? []).length;
if (loads !== 1) throw new Error(`build: bundle registers ${loads} modules; expected exactly 1`);
if (!bundle.includes('liveTerminalModule')) throw new Error('build: live module missing from the bundle');
if (!bundle.includes('exports.__liveTerminal.apply(ctx);')) {
  throw new Error('build: apply() does not start the live module');
}

const header = `/**
 * dsh-better-uiux — browser half. GENERATED by build.mjs; do not edit directly.
 *
 * ONE module, merged from two sources:
 *   1. core.js           — config store, the "Better UIUX" Settings section, custom CSS, message editor
 *   2. live-terminal.js  — live terminal output (ported from dsh-plugin-live-terminal), gated on the switch
 *
 * The live half is INLINED into the core module rather than registered separately.
 * The shell only calls apply() for a package's primary module, so a second
 * registration would load and never start — which is exactly how the live
 * terminal silently did nothing. Registered id: ${(bundle.match(/id:\s*'([^']+)'/) ?? [, '?'])[1]}
 */

`;

const final = header + bundle.trimEnd() + '\n';
writeFileSync(join(pluginDir, 'client.js'), final, 'utf-8');
console.log(`wrote client.js  ${final.length} chars  (1 module, live half inlined)`);
