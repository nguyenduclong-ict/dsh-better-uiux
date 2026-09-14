// Config-store edge cases that would otherwise only be discovered in the GUI:
//   - a UTF-8 BOM in config.json (an editor or PowerShell adds one) must not
//     silently reset every switch to its default
//   - an explicit `false` on disk must survive, while an absent key takes the
//     shipped default (on)
//   - a corrupt file must fall back to the defaults instead of throwing
//
// Usage:  node tests/config-edge-test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** Apply the host half against a throwaway DSH_HOME holding `rawConfig`. */
async function readConfigThrough(rawConfig, { write = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'better-uiux-edge-'));
  const dir = join(home, 'plugins', 'dsh-better-uiux');
  mkdirSync(dir, { recursive: true });
  if (write) writeFileSync(join(dir, 'config.json'), rawConfig, 'utf-8');
  process.env.DSH_HOME = home;

  const mod = await import(`${pathToFileURL(join(pluginDir, 'index.js')).href}?edge=${Math.random()}`);
  const routes = new Map();
  mod.apply({
    logger: { info() {}, warn() {} },
    webServer: { register(route) { routes.set(route.path, route); return () => {}; } },
    subprocess: { spawn: () => ({ pid: 1, collected: null, done: Promise.resolve(), terminate() {} }) },
    inject() {},
    get: () => undefined
  });

  let payload = '';
  await routes.get('/api/better-uiux/config').handler(
    { method: 'GET', url: '/api/better-uiux/config', on() {}, destroy() {} },
    { setHeader() {}, statusCode: 200, end(chunk) { payload += chunk; } }
  );
  rmSync(home, { recursive: true, force: true });
  return JSON.parse(payload);
}

console.log('dsh-better-uiux config-store edge cases\n');

console.log('1. absent file -> shipped defaults');
{
  const body = await readConfigThrough('', { write: false });
  check('liveTerminal defaults on', body.features.liveTerminal === true, JSON.stringify(body.features));
  check('customCss defaults on', body.features.customCss === true);
  // Edit is opt-in: it cannot rewrite a message in place, it branches the session.
  check('editMessage defaults OFF (opt-in)', body.features.editMessage === false, JSON.stringify(body.features));
}

console.log('\n2. UTF-8 BOM must not reset the switches');
{
  const raw = `\uFEFF${JSON.stringify({ features: { liveTerminal: false, customCss: true, editMessage: true }, css: '/*x*/' })}`;
  const body = await readConfigThrough(raw);
  check('explicit false preserved despite the BOM', body.features.liveTerminal === false, JSON.stringify(body.features));
  check('explicit true preserved', body.features.customCss === true);
  // Edit message is temporarily hidden, so the stored value is IGNORED rather
  // than honoured — a config.json from an earlier build must not revive it.
  check('explicit editMessage true is forced off while the feature is hidden', body.features.editMessage === false, JSON.stringify(body.features));
  check('css preserved', body.css === '/*x*/');
}

console.log('\n3. absent keys take the default, explicit keys win');
{
  const raw = JSON.stringify({ features: { customCss: false } });
  const body = await readConfigThrough(raw);
  check('absent liveTerminal -> default on', body.features.liveTerminal === true, JSON.stringify(body.features));
  check('absent editMessage -> default off', body.features.editMessage === false, JSON.stringify(body.features));
  check('explicit customCss false kept', body.features.customCss === false);
}

console.log('\n4. corrupt file -> defaults, never a throw');
{
  const body = await readConfigThrough('{ this is not json');
  check('liveTerminal falls back on', body.features.liveTerminal === true, JSON.stringify(body.features));
  check('customCss falls back on', body.features.customCss === true);
  check('editMessage falls back off', body.features.editMessage === false, JSON.stringify(body.features));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exitCode = 1;
} else {
  console.log('config-store edge cases ok');
}
