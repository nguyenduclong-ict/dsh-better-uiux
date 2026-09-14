// Syntax gate for this plugin's shipped artifacts.
//
// The client bundle is a browser script (it references `window`), so it is
// COMPILED here inside the CJS wrapper the web shell's module loader uses — but
// never executed. The host half is real ESM and is imported for its parse check.
//
// Usage:  node syntax-check.mjs [plugin-dir]

import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());

/** Browser bundle (generated). */
const clientFiles = ['client.js'];
/** Host half: real ESM. */
const hostFiles = ['index.js'];

let failed = 0;

for (const file of clientFiles) {
  const path = join(root, file);
  const source = readFileSync(path, 'utf-8');
  try {
    new Script(`(function (require, module, exports, window) {\n${source}\n})`, { filename: path });
    const loads = (source.match(/window\.__ModuleLoader__\.load\(/g) ?? []).length;
    console.log(`ok    ${file}  (${source.length} chars, ${loads} module registration(s))`);
    // Exactly ONE: the shell only runs apply() for a package's primary module, so a
    // second registration would load and never start (see build.mjs).
    if (loads !== 1) {
      failed += 1;
      console.error(`FAIL  ${file}: expected exactly 1 module registration, found ${loads}`);
    }
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${file}: ${error.message}`);
  }
}

for (const file of hostFiles) {
  const path = join(root, file);
  const source = readFileSync(path, 'utf-8');
  try {
    const mod = await import(`file:///${path.replace(/\\/g, '/')}?check=${Date.now()}`);
    const missing = ['name', 'inject', 'apply'].filter((key) => mod[key] === undefined);
    if (missing.length > 0) throw new Error(`missing exports: ${missing.join(', ')}`);
    console.log(`ok    ${file}  (${source.length} chars) exports name/inject/apply`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${file}: ${error.message}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} artifact(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall artifacts ok');
}
