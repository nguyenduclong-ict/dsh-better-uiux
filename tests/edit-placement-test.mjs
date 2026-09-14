// Exercises the message editor's DOM PLACEMENT logic directly.
//
// `placeEditButton` / `findActionRow` / `findClockSibling` decide the one thing
// the user asked for visually: the Edit button sits AFTER the clock and BEFORE
// the copy button. That ordering is cheap to get wrong and invisible in every
// other test, so the real function bodies are lifted out of the shipped bundle
// and run here against a tiny element stub.
//
// Usage:  node tests/edit-placement-test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(pluginDir, 'client.js'), 'utf-8');

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

// ---------------------------------------------------------------------------
// Lift the real implementations out of the bundle.
// ---------------------------------------------------------------------------

/** Slice a top-level function/factory body by its banner comment or signature. */
function slice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`marker not found: ${startMarker.slice(0, 60)}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`end marker not found after: ${startMarker.slice(0, 60)}`);
  return source.slice(start, end);
}

const placementSource = [
  slice('    function findActionRow(row) {', '    /**\n     * The clock span'),
  slice('    function findClockSibling(container) {', '    /** Install one Edit button'),
  slice('    function placeEditButton(container, copyButton, button) {', '    /** Add the button to every user row')
].join('\n');

/** The module constants those functions close over. */
const EDIT_BTN_CLASS = 'dsh-bu-edit-btn';
const COPY_LABELS = new Set(['copy', 'copied', '复制', '复制成功']);

// eslint-disable-next-line no-new-func
const placement = new Function(
  'EDIT_BTN_CLASS',
  'COPY_LABELS',
  `${placementSource}\nreturn { findActionRow, findClockSibling, placeEditButton };`
)(EDIT_BTN_CLASS, COPY_LABELS);

// ---------------------------------------------------------------------------
// A minimal element stub: parentElement, children, className, querySelectorAll.
// ---------------------------------------------------------------------------

class El {
  constructor(className = '', attrs = {}) {
    this.className = className;
    this.attrs = new Map(Object.entries(attrs));
    this.children = [];
    this.parentElement = null;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get nextSibling() {
    if (this.parentElement === null) return null;
    const index = this.parentElement.children.indexOf(this);
    return this.parentElement.children[index + 1] ?? null;
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  setAttribute(name, value) {
    this.attrs.set(name, value);
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, reference) {
    if (reference === null || reference === undefined) return this.appendChild(child);
    const index = this.children.indexOf(reference);
    if (index < 0) return this.appendChild(child);
    if (child.parentElement !== null) {
      const previous = child.parentElement.children.indexOf(child);
      if (previous >= 0) child.parentElement.children.splice(previous, 1);
    }
    child.parentElement = this;
    this.children.splice(index, 0, child);
    return child;
  }
  /** Only the two selector shapes these functions use. */
  querySelectorAll(selector) {
    const out = [];
    const wantButtonWithLabel = selector === 'button[aria-label]';
    const wantActions = selector === '[class*="_actions"]';
    const walk = (node) => {
      for (const child of node.children) {
        if (wantButtonWithLabel && child.tagName === 'button' && child.getAttribute('aria-label') !== null) out.push(child);
        else if (wantActions && String(child.className).includes('_actions')) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  /** Render the row as class names, so ordering failures read clearly. */
  describe() {
    return this.children
      .map((child) => {
        const label = child.getAttribute('aria-label');
        if (child.tagName === 'button') return label === null ? `<button ${child.className}>` : `<button "${label}">`;
        const cls = String(child.className);
        return cls.includes('timeStart') ? '<clock>' : `<div ${cls}>`;
      })
      .join(' ');
  }
}

/** Build a user-message row shaped like the shell renders one. */
function makeUserRow({ withClock = true, copyLabel = 'Copy' } = {}) {
  const row = new El('userRow', { 'data-chat-flow-kind': 'user' });
  const stack = new El('userStack');
  const bubble = new El('bubble');
  const actions = new El('qJxi1G_actions');
  if (withClock) actions.appendChild(new El('qJxi1G_timeStart'));
  const copy = new El('qJxi1G_action', { 'aria-label': copyLabel });
  copy.tagName = 'button';
  actions.appendChild(copy);
  stack.appendChild(bubble);
  row.appendChild(stack);
  row.appendChild(actions);
  return { row, actions, copy, bubble };
}

const editButton = () => {
  const button = new El(EDIT_BTN_CLASS, { 'aria-label': 'Edit' });
  button.tagName = 'button';
  return button;
};

console.log('dsh-better-uiux edit-button placement\n');

console.log('1. the extracted code is the real implementation');
check('findActionRow found the row via the copy button', (() => {
  const { row, actions } = makeUserRow();
  return placement.findActionRow(row).container === actions;
})());
check('findActionRow also reports the copy button', (() => {
  const { row, copy } = makeUserRow();
  return placement.findActionRow(row).copyButton === copy;
})());
check('findClockSibling finds the clock', (() => {
  const { actions } = makeUserRow();
  return String(placement.findClockSibling(actions).className).includes('timeStart');
})());

console.log('\n2. placement: after the clock, before copy');
{
  const { row, actions, copy } = makeUserRow();
  const button = editButton();
  const found = placement.findActionRow(row);
  placement.placeEditButton(found.container, found.copyButton, button);
  check('order is clock -> copy -> edit', actions.describe() === '<clock> <button "Copy"> <button "Edit">', actions.describe());
  check('edit is immediately after copy', copy.nextSibling === button);
  check('edit is last in the row', actions.children[actions.children.length - 1] === button);
}

console.log('\n3. row without a clock: copy still precedes edit');
{
  const { row, actions, copy } = makeUserRow({ withClock: false });
  const button = editButton();
  const found = placement.findActionRow(row);
  placement.placeEditButton(found.container, found.copyButton, button);
  check('order is copy -> edit', actions.describe() === '<button "Copy"> <button "Edit">', actions.describe());
  check('edit is immediately after copy', copy.nextSibling === button);
}

console.log('\n4. re-homing keeps the slot when React replaced the row');
{
  const { row, actions, copy } = makeUserRow();
  const button = editButton();
  const found = placement.findActionRow(row);
  placement.placeEditButton(found.container, found.copyButton, button);
  check('placed correctly first', actions.describe() === '<clock> <button "Copy"> <button "Edit">', actions.describe());

  // React swaps the whole action row for a fresh one (no edit button inside).
  const fresh = new El('qJxi1G_actions');
  fresh.appendChild(new El('qJxi1G_timeStart'));
  const freshCopy = new El('qJxi1G_action', { 'aria-label': 'Copy' });
  freshCopy.tagName = 'button';
  fresh.appendChild(freshCopy);
  row.children[1] = fresh;
  fresh.parentElement = row;

  const again = placement.findActionRow(row);
  placement.placeEditButton(again.container, again.copyButton, button);
  check('re-homed into the new row', button.parentElement === fresh);
  check('order restored: clock -> copy -> edit', fresh.describe() === '<clock> <button "Copy"> <button "Edit">', fresh.describe());
}

console.log('\n5. the copy label flips to "Copied" after a click');
{
  const { row, actions, copy } = makeUserRow({ copyLabel: 'Copied' });
  const button = editButton();
  const found = placement.findActionRow(row);
  check('still resolves the copy button', found.copyButton === copy);
  placement.placeEditButton(found.container, found.copyButton, button);
  check('order is clock -> copied -> edit', actions.describe() === '<clock> <button "Copied"> <button "Edit">', actions.describe());
}

console.log('\n6. localized copy label (zh) still anchors the row');
{
  const { row, actions } = makeUserRow({ copyLabel: '复制' });
  const button = editButton();
  const found = placement.findActionRow(row);
  check('copy button found by the zh label', found.copyButton !== null);
  placement.placeEditButton(found.container, found.copyButton, button);
  check('order is clock -> 复制 -> edit', actions.describe() === '<clock> <button "复制"> <button "Edit">', actions.describe());
}

console.log('\n7. no labelled button at all -> falls back to the _actions wrapper');
{
  const row = new El('userRow', { 'data-chat-flow-kind': 'user' });
  const actions = new El('qJxi1G_actions');
  actions.appendChild(new El('qJxi1G_timeStart'));
  row.appendChild(actions);
  const found = placement.findActionRow(row);
  check('container resolved via the class fallback', found.container === actions);
  check('no copy button reported', found.copyButton === null);
  const button = editButton();
  placement.placeEditButton(found.container, found.copyButton, button);
  check('placed after the clock', actions.describe() === '<clock> <button "Edit">', actions.describe());
}

console.log('\n8. an empty action row still receives the button');
{
  const row = new El('userRow', { 'data-chat-flow-kind': 'user' });
  const actions = new El('qJxi1G_actions');
  row.appendChild(actions);
  const found = placement.findActionRow(row);
  const button = editButton();
  placement.placeEditButton(found.container, found.copyButton, button);
  check('appended to the row', actions.describe() === '<button "Edit">', actions.describe());
}

console.log('\n9. a second copy-like action does not displace the button');
{
  const { row, actions } = makeUserRow();
  // A third action appears to the right of copy (e.g. a future shell button).
  const other = new El('qJxi1G_action', { 'aria-label': 'Retry' });
  other.tagName = 'button';
  actions.appendChild(other);

  const button = editButton();
  const found = placement.findActionRow(row);
  placement.placeEditButton(found.container, found.copyButton, button);
  check(
    'edit sits directly right of copy, before the other action',
    actions.describe() === '<clock> <button "Copy"> <button "Edit"> <button "Retry">',
    actions.describe()
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exitCode = 1;
} else {
  console.log('edit-button placement ok');
}
