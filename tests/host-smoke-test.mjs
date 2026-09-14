// Behavioural smoke test for the host half of dsh-better-uiux.
//
// The host half is a plain ESM module that only needs a cordis-shaped context,
// so it can be driven directly here: `apply()` is called with a fake ctx that
// records the registered routes and the wrapped services, then each route is
// invoked the way the Harness web server would invoke it.
//
// Covers:
//   - every route registered exactly once, at the expected paths
//   - config round-trip through a throwaway DSH_HOME (persist + reload)
//   - feature gating: a disabled feature answers `enabled:false` and does nothing
//   - the subprocess.spawn wrapper records nothing while liveTerminal is off
//
// Usage:  node host-smoke-test.mjs

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

// The host half resolves its store from DSH_HOME at import time, so this must be
// set before the dynamic import below.
const probeHome = mkdtempSync(join(tmpdir(), 'dsh-better-uiux-'));
process.env.DSH_HOME = probeHome;

const mod = await import(`../index.js?smoke=${Date.now()}`);

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

/** Minimal fake ctx that records everything the plugin touches. */
function makeCtx() {
  const routes = new Map();
  const spawnSpecs = [];
  const injected = [];
  const logs = [];

  const ctx = {
    logger: {
      info: (message) => logs.push(['info', String(message)]),
      warn: (message) => logs.push(['warn', String(message)])
    },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      }
    },
    subprocess: {
      spawn(spec) {
        spawnSpecs.push(spec);
        return {
          pid: 4242,
          collected: {
            stdout: {
              readFrom: () => ({ text: '', nextOffset: 0 })
            }
          },
          done: Promise.resolve(),
          terminate() {}
        };
      }
    },
    inject(services, callback) {
      injected.push(services);
      if (services.includes('jobs')) {
        callback({ jobs: { store: new Map(), start: () => 'job-x' } });
      } else if (services.includes('tools')) {
        callback({ on: () => {} });
      } else if (services.includes('shellEnv')) {
        callback({ shellEnv: { register: () => {} } });
      }
    },
    get: () => undefined
  };

  return { ctx, routes, spawnSpecs, injected, logs };
}

/** Invoke one registered route with a fake req/res pair. */
async function callRoute(routes, path, { method = 'GET', body, query = '' } = {}) {
  const route = routes.get(path);
  if (route === undefined) throw new Error(`route not registered: ${path}`);

  const req = new EventEmitter();
  req.method = method;
  req.url = `${path}${query}`;
  req.destroy = () => {};

  let statusCode = 0;
  let payload = '';
  const headers = {};
  const res = {
    setHeader: (key, value) => {
      headers[key] = value;
    },
    end: (chunk) => {
      if (chunk !== undefined) payload += String(chunk);
    }
  };
  Object.defineProperty(res, 'statusCode', {
    get: () => statusCode,
    set: (value) => {
      statusCode = value;
    }
  });

  const promise = route.handler(req, res);
  // Body-carrying verbs settle after 'end'; GET-style routes settle immediately.
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  }
  await promise;

  let parsed = null;
  try {
    parsed = payload === '' ? null : JSON.parse(payload);
  } catch {
    parsed = payload;
  }
  return { statusCode, headers, body: parsed, raw: payload };
}

console.log('dsh-better-uiux host smoke test');
console.log(`DSH_HOME = ${probeHome}\n`);

// ---------------------------------------------------------------------------
console.log('1. apply() registers the full route surface');
// ---------------------------------------------------------------------------
const { ctx, routes, spawnSpecs, injected } = makeCtx();
mod.apply(ctx);

const expectedPaths = [
  '/api/better-uiux/config',
  '/api/better-uiux/jobs',
  '/api/better-uiux/output',
  '/api/better-uiux/stop'
];
for (const path of expectedPaths) {
  check(`route ${path}`, routes.has(path));
}

// Compatibility aliases: the ported browser half used to call the STANDALONE
// plugin's namespace. A cached client hitting those paths got 401 and silently
// showed no output, so the live routes are also served under the legacy prefix.
const legacyPaths = ['/api/live-terminal/jobs', '/api/live-terminal/output', '/api/live-terminal/stop'];
for (const path of legacyPaths) {
  check(`legacy alias ${path}`, routes.has(path));
}
// `/config` never had a legacy name, so it must NOT be aliased.
check('config is not aliased under the legacy prefix', !routes.has('/api/live-terminal/config'));

const allExpected = [...expectedPaths, ...legacyPaths];
check(
  'no unexpected routes',
  routes.size === allExpected.length,
  `got ${routes.size}: ${[...routes.keys()].join(', ')}`
);
// The alias must share the SAME handler function, not a re-implementation. The
// mock stores the whole route definition, so compare its `handler`.
check(
  'aliases reuse the canonical handlers',
  routes.get('/api/live-terminal/jobs').handler === routes.get('/api/better-uiux/jobs').handler
    && routes.get('/api/live-terminal/output').handler === routes.get('/api/better-uiux/output').handler
    && routes.get('/api/live-terminal/stop').handler === routes.get('/api/better-uiux/stop').handler
);
check('injected shellEnv/jobs/tools', ['shellEnv', 'jobs', 'tools'].every((s) => injected.some((list) => list.includes(s))));

// ---------------------------------------------------------------------------
console.log('\n2. config defaults: live + css on, edit off');
// ---------------------------------------------------------------------------
let response = await callRoute(routes, '/api/better-uiux/config');
check('GET /config answers 200', response.statusCode === 200, `got ${response.statusCode}`);
check('features present', response.body !== null && typeof response.body.features === 'object');
check(
  'liveTerminal starts on',
  response.body.features.liveTerminal === true,
  JSON.stringify(response.body.features)
);
check(
  'customCss starts on',
  response.body.features.customCss === true,
  JSON.stringify(response.body.features)
);
// Opt-in: editing a message branches the session, so it is never assumed.
check(
  'editMessage starts OFF (opt-in)',
  response.body.features.editMessage === false,
  JSON.stringify(response.body.features)
);
check(
  'the shipped defaults object agrees',
  mod.DEFAULT_FEATURES.liveTerminal === true
    && mod.DEFAULT_FEATURES.customCss === true
    && mod.DEFAULT_FEATURES.editMessage === false,
  JSON.stringify(mod.DEFAULT_FEATURES)
);
check('css starts empty', response.body.css === '');

// ---------------------------------------------------------------------------
console.log('\n3. POST /config persists and ignores junk');
// ---------------------------------------------------------------------------
response = await callRoute(routes, '/api/better-uiux/config', {
  method: 'POST',
  body: {
    features: { liveTerminal: false, editMessage: false, bogus: 'yes', customCss: 'nope' },
    css: ':root { --x: 1; }',
    extra: 'ignored'
  }
});
check('POST answers 200 with saved:true', response.statusCode === 200 && response.body.saved === true, JSON.stringify(response.body));
check('liveTerminal switched off', response.body.features.liveTerminal === false);
check('editMessage switched off', response.body.features.editMessage === false);
check('non-boolean flag ignored (stays on)', response.body.features.customCss === true);
check('unknown flag dropped', response.body.features.bogus === undefined);
check('css stored', response.body.css === ':root { --x: 1; }');

const storeFile = join(probeHome, 'plugins', 'dsh-better-uiux', 'config.json');
check('config.json written', existsSync(storeFile), storeFile);
if (existsSync(storeFile)) {
  const onDisk = JSON.parse(readFileSync(storeFile, 'utf-8'));
  check('disk copy matches', onDisk.features.liveTerminal === false && onDisk.css === ':root { --x: 1; }');
}

response = await callRoute(routes, '/api/better-uiux/config', { method: 'PUT' });
check('unsupported verb answers 405', response.statusCode === 405, `got ${response.statusCode}`);

// ---------------------------------------------------------------------------
console.log('\n4. live-terminal routes gate on the switch');
// ---------------------------------------------------------------------------
// The switch is currently OFF (set above): every terminal route must report it.
for (const path of ['/api/better-uiux/jobs', '/api/better-uiux/output', '/api/better-uiux/stop']) {
  response = await callRoute(routes, path);
  check(`${path} gated off`, response.body.enabled === false, JSON.stringify(response.body));
}

// Switch it back on and confirm the routes serve again.
await callRoute(routes, '/api/better-uiux/config', {
  method: 'POST',
  body: { features: { liveTerminal: true } }
});
response = await callRoute(routes, '/api/better-uiux/jobs');
check('re-enabled -> jobs served', response.body.enabled === true && Array.isArray(response.body.jobs));

// Turn the feature off and confirm every route reports the disabled shape.
await callRoute(routes, '/api/better-uiux/config', {
  method: 'POST',
  body: { features: { liveTerminal: false } }
});

for (const path of ['/api/better-uiux/jobs', '/api/better-uiux/output', '/api/better-uiux/stop']) {
  response = await callRoute(routes, path);
  check(`${path} gated off`, response.body.enabled === false, JSON.stringify(response.body));
}
response = await callRoute(routes, '/api/better-uiux/output', { query: '?jobId=abc' });
check('gated output has no job payload', response.body.output === '' && response.body.found === false);

// ---------------------------------------------------------------------------
console.log('\n5. subprocess.spawn wrapper records nothing while the feature is off');
// ---------------------------------------------------------------------------
spawnSpecs.length = 0;
ctx.subprocess.spawn({ argv: ['pwsh', '-Command', 'echo hi'], env: { DSH_CALL_ID: 'call_1' }, cwd: probeHome });
const afterOff = await callRoute(routes, '/api/better-uiux/output', { query: '?jobId=call_1' });
check('no process tracked while off', afterOff.body.found === false, JSON.stringify(afterOff.body));

await callRoute(routes, '/api/better-uiux/config', {
  method: 'POST',
  body: { features: { liveTerminal: true } }
});
ctx.subprocess.spawn({ argv: ['pwsh', '-Command', 'echo hi'], env: { DSH_CALL_ID: 'call_1' }, cwd: probeHome });
const afterOn = await callRoute(routes, '/api/better-uiux/output', { query: '?jobId=call_1' });
check('process tracked once on', afterOn.body.found === true, JSON.stringify(afterOn.body));
check('command decoded from argv', afterOn.body.command === 'echo hi', JSON.stringify(afterOn.body.command));

// ---------------------------------------------------------------------------
console.log('\n6. a fresh apply() reloads the persisted config');
// ---------------------------------------------------------------------------
const reloadHome = probeHome;
{
  const fresh = makeCtx();
  const freshMod = await import(`../index.js?smoke2=${Date.now()}`);
  freshMod.apply(fresh.ctx);
  const reloaded = await callRoute(fresh.routes, '/api/better-uiux/config');
  check(
    'liveTerminal persisted across a reload',
    reloaded.body.features.liveTerminal === true,
    JSON.stringify(reloaded.body.features)
  );
  check('css persisted across a reload', reloaded.body.css === ':root { --x: 1; }', reloaded.body.css);
}

rmSync(reloadHome, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exitCode = 1;
} else {
  console.log('host half ok');
}
