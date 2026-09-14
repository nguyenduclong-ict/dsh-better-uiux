// Full uninstall / reinstall for this plugin in the DSH web profile.
//
//   node local-install.mjs status     # report current state
//   node local-install.mjs uninstall  # remove everything, INCLUDING settings data
//   node local-install.mjs install    # link + register in the profile
//
// The package is installed as a DIRECTORY JUNCTION so edits in this checkout are
// live without reinstalling — and a junction is removed with rmdir (the link
// only), never with a recursive delete, which on Windows would follow the link
// and destroy the checkout it points at.
//
// Paths are derived from THIS file's location, so a moved checkout still manages
// itself. `npm run uninstall:local` / `install:local` / `status:local` wrap these.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

/** This checkout, in forward-slash form; the package name is its directory name. */
const CHECKOUT = dirname(fileURLToPath(import.meta.url)).split(sep).join('/');
const PACKAGE = CHECKOUT.slice(CHECKOUT.lastIndexOf('/') + 1);

/** The DSH desktop harness root, honouring DSH_HOME when the shell provides it. */
function resolveHarnessHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  if (fromEnv !== '') return fromEnv.split(sep).join('/');
  const appData = typeof process.env.APPDATA === 'string' ? process.env.APPDATA.trim() : '';
  if (appData !== '') return `${appData.split(sep).join('/')}/dsh-desktop/harness`;
  throw new Error('Cannot locate the DSH harness root: set DSH_HOME or APPDATA.');
}

const HARNESS = resolveHarnessHome();
const PROFILE = `${HARNESS}/profiles/web`;
const MANIFEST = join(PROFILE, 'package.json');
const LINK = join(PROFILE, 'node_modules', PACKAGE);
const DATA = join(HARNESS, 'plugins', PACKAGE);
const BACKUP_DIR = join(tmpdir(), `${PACKAGE}-removed-data`);

const command = process.argv[2] ?? 'status';

function readManifest() {
  return JSON.parse(readFileSync(MANIFEST, 'utf-8').replace(/^\uFEFF/, ''));
}

function writeManifest(json) {
  // Back up first, then write without a BOM and with pnpm's 2-space indent.
  copyFileSync(MANIFEST, `${MANIFEST}.bak-${Date.now()}`);
  writeFileSync(MANIFEST, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
}

function report() {
  const json = readManifest();
  const bundles = json.dsh?.profile?.bundles ?? [];
  const deps = json.dependencies ?? {};
  console.log(`package        : ${PACKAGE}`);
  console.log(`checkout       : ${CHECKOUT}  (client.js: ${existsSync(join(CHECKOUT, 'client.js'))})`);
  console.log(`in bundles     : ${bundles.includes(PACKAGE)}  (${bundles.length} bundles)`);
  console.log(`in dependencies: ${Object.hasOwn(deps, PACKAGE)}  -> ${deps[PACKAGE] ?? '-'}`);
  if (existsSync(LINK)) {
    const stat = lstatSync(LINK);
    console.log(`node_modules   : present (junction=${stat.isSymbolicLink()})`);
  } else {
    console.log('node_modules   : not present');
  }
  console.log(`data dir       : ${DATA}  (config.json: ${existsSync(join(DATA, 'config.json'))})`);
}

function uninstall() {
  console.log('--- uninstall ---');

  // 1. Data. Keep a copy OUTSIDE the plugin tree so this stays reversible even
  //    though the user asked for the settings to go.
  if (existsSync(DATA)) {
    rmSync(BACKUP_DIR, { recursive: true, force: true });
    mkdirSync(BACKUP_DIR, { recursive: true });
    for (const name of ['config.json']) {
      const from = join(DATA, name);
      if (existsSync(from)) copyFileSync(from, join(BACKUP_DIR, name));
    }
    rmSync(DATA, { recursive: true, force: true });
    console.log(`removed data   : ${DATA}`);
    console.log(`backup copy    : ${BACKUP_DIR}`);
  } else {
    console.log('data dir       : already absent');
  }

  // 2. The junction. rmdir removes the LINK only.
  if (existsSync(LINK)) {
    rmdirSync(LINK);
    console.log(`removed link   : ${LINK}`);
    if (!existsSync(join(CHECKOUT, 'client.js'))) {
      throw new Error('checkout disappeared — junction removal followed the link');
    }
  } else {
    console.log('link           : already absent');
  }

  // 3. Every manifest reference.
  const json = readManifest();
  const before = json.dsh?.profile?.bundles?.length ?? 0;
  if (json.dsh?.profile !== undefined) {
    json.dsh.profile.bundles = (json.dsh.profile.bundles ?? []).filter((name) => name !== PACKAGE);
  }
  if (json.dependencies !== undefined) delete json.dependencies[PACKAGE];
  writeManifest(json);
  console.log(`manifest       : bundles ${before} -> ${json.dsh.profile.bundles.length}, dependency dropped`);

  console.log('\nlocalStorage key `dsh_better_uiux_config_v2` lives in the BROWSER, not here.');
  console.log('Clear it in DevTools:  localStorage.removeItem("dsh_better_uiux_config_v2")');
}

function install() {
  console.log('--- install (local link) ---');
  if (!existsSync(join(CHECKOUT, 'client.js'))) {
    throw new Error(`client.js missing in ${CHECKOUT} — run "node build.mjs" there first`);
  }

  mkdirSync(join(PROFILE, 'node_modules'), { recursive: true });

  if (existsSync(LINK)) {
    console.log(`link           : already present`);
  } else {
    // mklink /J needs no elevation, unlike New-Item -ItemType SymbolicLink.
    execFileSync('cmd', ['/c', 'mklink', '/J', LINK.replace(/\//g, '\\'), CHECKOUT.replace(/\//g, '\\')], { stdio: 'pipe' });
    if (!existsSync(join(LINK, 'client.js'))) throw new Error('junction does not resolve to the checkout');
    console.log(`link           : created -> ${CHECKOUT}`);
  }

  const json = readManifest();
  json.dsh ??= {};
  json.dsh.profile ??= {};
  const bundles = json.dsh.profile.bundles ?? [];
  if (!bundles.includes(PACKAGE)) bundles.unshift(PACKAGE);
  json.dsh.profile.bundles = bundles;
  json.dependencies ??= {};
  json.dependencies[PACKAGE] = `file:${CHECKOUT}`;
  writeManifest(json);
  console.log(`manifest       : registered (first in bundles) + dependency file:${CHECKOUT}`);
  console.log('\nRestart DSH Desktop, then open Settings → Better UIUX.');
  console.log('Shipped defaults: liveTerminal=true customCss=true editMessage=false (edit is opt-in), css=""');
}

/**
 * Bundles provided by the DSH app itself. They are NOT in the profile's
 * node_modules, so "does it resolve?" is the wrong test for them — treating them
 * as dead and dropping them would strip the shell out of its own bundle list.
 */
const SHELL_EMBEDDED = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

/**
 * Drop `dsh.profile.bundles` entries that resolve to nothing.
 *
 * `pnpm remove` cleans `dependencies` and node_modules, but the bundles list is
 * DSH's own and keeps the stale name. An unresolvable bundle entry is a dead
 * reference the shell tries to load on every start, so it is worth pruning.
 *
 * Only entries under an explicit allowlist of removals are ever dropped. An
 * earlier version dropped everything that did not resolve, which also removed the
 * shell-embedded bundles and would have broken startup.
 */
function prune() {
  console.log('--- prune dead bundle entries ---');
  const json = readManifest();
  const bundles = json.dsh?.profile?.bundles ?? [];
  const keep = [];
  const dropped = [];
  for (const name of bundles) {
    if (SHELL_EMBEDDED.includes(name)) {
      keep.push(name);
      continue;
    }
    const resolved = name.startsWith('@')
      ? join(PROFILE, 'node_modules', ...name.split('/'))
      : join(PROFILE, 'node_modules', name);
    if (existsSync(resolved)) keep.push(name);
    else dropped.push(name);
  }
  if (dropped.length === 0) {
    console.log('bundles        : nothing to prune');
    return;
  }
  json.dsh.profile.bundles = keep;
  writeManifest(json);
  console.log(`bundles        : dropped ${dropped.join(', ')}`);
  console.log(`bundles        : ${bundles.length} -> ${keep.length}`);
  console.log(`kept (shell)   : ${SHELL_EMBEDDED.join(', ')}`);
}

if (command === 'status') report();
else if (command === 'uninstall') uninstall();
else if (command === 'install') install();
else if (command === 'prune') prune();
else {
  console.error(`unknown command "${command}" — expected status | install | uninstall | prune`);
  process.exitCode = 1;
}
