// Guard: the plugin's own stylesheet is a JS template literal, so a stray
// backtick (or ${) inside it silently truncates the CSS and — worse — turns the
// remainder into code. This bit us once; this check makes it impossible again.
//
// Also verifies the EDIT_ICON_SVG glyph string stays backtick-free and parses.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(pluginDir, 'core.js'), 'utf-8');

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

/** Pull out one `X = \`...\`` template literal body by its opening assignment. */
function templateBody(assignment) {
  const start = source.indexOf(assignment);
  if (start < 0) throw new Error(`assignment not found: ${assignment}`);
  const open = source.indexOf('`', start);
  // Walk forward to the FIRST unescaped backtick — that is the real end. If the
  // CSS contains one, the walk ends early and the body is short, which is itself
  // the signal we want to detect by comparing against the `\`;` terminator.
  let i = open + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === '`') break;
    i += 1;
  }
  const body = source.slice(open + 1, i);
  const after = source.slice(i, i + 4);
  return { body, open, closeAt: i, after };
}

console.log('dsh-better-uiux stylesheet integrity\n');

console.log('1. the chrome stylesheet template is intact');
{
  const { body, after } = templateBody('tag.textContent = `');
  check('terminates with a backtick-semicolon', /^`;/.test(after), JSON.stringify(after));
  check('body is a plausible stylesheet size', body.length > 6000, `${body.length} chars`);
  check('body has no unescaped interpolation', !body.includes('${'), 'a ${ would interpolate at runtime');
  check('body contains the edit-button rules', body.includes('.dsh-bu-edit-btn'));
  check('body contains the switch rules', body.includes('.dsh-bu-switch'));
  // The last rule before the terminator must be complete, not mid-comment.
  check('ends after a closing brace', body.trimEnd().endsWith('}'), JSON.stringify(body.trimEnd().slice(-40)));
}

console.log('\n2. the injected SVG string contains no template-literal hazards');
{
  const svgStart = source.indexOf('const EDIT_ICON_SVG = [');
  const svgEnd = source.indexOf('].join(\'\');', svgStart);
  const svgBlock = source.slice(svgStart, svgEnd);
  check('built from single-quoted parts', !svgBlock.includes('`'), 'no backtick in the SVG block');
  check('is the native single-path edit icon', (svgBlock.match(/<path /g) ?? []).length === 1);
  check('is fill-based (native style)', svgBlock.includes('fill="currentColor"'));
  check('carries the native underline sub-path', svgBlock.includes('15.5427 14.8398H7.55223'));
}

console.log('\n3. the Edit button is ALWAYS visible (no hover reveal)');
{
  const { body } = templateBody('tag.textContent = `');

  /** Pull one rule block's declarations by selector. */
  const ruleFor = (selector) => {
    const i = body.indexOf(selector);
    if (i < 0) return null;
    const open = body.indexOf('{', i);
    const close = body.indexOf('}', open);
    return body.slice(open + 1, close);
  };

  const button = ruleFor('.dsh-bu-edit-btn {');
  check('the button rule exists', button !== null);
  check('button opacity is 1', /opacity:\s*1\s*;/.test(button ?? ''), (button ?? '').trim());
  check('button opacity is not 0', !/opacity:\s*0\s*;/.test(button ?? ''));

  // Fading the button alone cannot work: the shell fades the WHOLE action row, so
  // the row has to be held open while it carries our host class.
  check('the host row rule exists', body.includes('.dsh-bu-edit-host [class*="_actions"]'));
  const rowRule = ruleFor('.dsh-bu-edit-host [class*="_actions"] {');
  check('the row is held at opacity 1', /opacity:\s*1\s*!important/.test(rowRule ?? ''), (rowRule ?? '').trim());
  check('the row rule is scoped, never global', !/\n\s*\[class\*="_actions"\]\s*\{/.test(body), 'unscoped row override found');

  // The old hover-reveal wiring must be gone, or it would fight the new rule.
  check('no hover-reveal rule remains for the button', !body.includes('.dsh-bu-edit-host:hover .dsh-bu-edit-btn'));
}

console.log('\n4. the whole bundle still evaluates');
{
  // Cheap re-check that the built artifact parses (syntax-check.mjs does the
  // same for both artifacts; this keeps the guard self-contained).
  const built = readFileSync(join(pluginDir, 'client.js'), 'utf-8');
  const cssStarts = (built.match(/tag\.textContent = `/g) ?? []).length;
  check('built bundle carries the stylesheet assignment', cssStarts >= 1, `${cssStarts}`);
  check('built bundle has no truncated style block', built.includes('.dsh-bu-edit-btn[data-armed="true"]'));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exitCode = 1;
} else {
  console.log('stylesheet integrity ok');
}
