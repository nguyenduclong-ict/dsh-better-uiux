# dsh-better-uiux — engineering notes

> This is the development log kept while the plugin was built, not the user-facing
> README: see [`../README.md`](../README.md) for features and installation.
>
> It was written while **Edit message** was still a visible switch. That feature is
> now hidden and off (`EDIT_MESSAGE_HIDDEN` in `index.js` and `core.js`), so its
> sections below describe behaviour that is present in the code and still covered by
> the test suite, but unreachable in Settings.

One **Better UIUX** section in DSH Settings, bundling three interface enhancements
that used to live in separate plugins — each behind its own switch:

| Switch | What it does | Ported from |
| --- | --- | --- |
| **Live terminal output** | Streams foreground command output and background-job output into the transcript: live blocks, header dots, Copy / Stop / View Job, an output modal, and clickable native job rows. | `dsh-plugin-live-terminal` 0.3.5 |
| **Custom CSS** | Injects your own CSS snippet into the Web GUI's `<head>`, live as you type. | `dsh-plugin-custom-css` 0.1.0 |
| **Edit message** | Adds an **Edit** button to messages already sent in the transcript: rewrite one and re-run the conversation from that point. | new |

Every feature is **on by default**, so a fresh install is immediately useful. A
switched-off feature stops working entirely — routes answer `enabled:false`, the
subprocess wrapper records nothing, the DOM observers no-op, and turning the live
terminal off *tears down* every node it injected (styles, blocks, footer rows, the
modal root). That matters because DSH is expected to ship live terminal output
natively: when it does, switch this one off instead of uninstalling anything.

## Settings

**Settings → Better UIUX** (nav row id `better-uiux`, order 41 — right after Custom
CSS) contains:

- three switches, each with a one-line explanation
- the CSS editor (textarea, live-injected, auto-saved, debounced 500 ms)
- a note explaining exactly what "edit message" does to your sessions

### Shipped defaults

| switch | default | why |
| --- | --- | --- |
| **Live terminal output** | **on** | works with no setup; turn it off once DSH ships this natively |
| **Custom CSS** | **on** | harmless until you type something |
| **Edit message** | **off** (opt-in) | editing cannot rewrite a message in place — it branches the session, so it is never assumed |

`editMessage` is off by default deliberately. Nothing else in the plugin changes
your session topology; this one does, so it has to be asked for.

### Do not run two live terminals at once

If the standalone **`dsh-plugin-live-terminal`** is installed alongside this plugin,
both use the same `STYLE_ID` (`dsh-live-terminal-style`), the same modal root id and
the same `dsh-live-*` classes, so they overwrite and re-render each other's nodes.
The symptom is *"the switch is on but the output does not work"* — which names
nothing useful on its own, so the plugin detects it and says so in the console:

```
[dsh-better-uiux] CONFLICT: another live-terminal implementation is also active
(foreign stylesheet: true, modal roots: 2). Two copies fight over the same nodes…
```

The check runs before `ensureStyles()` takes ownership of the tag, because that call
replaces the very evidence it looks for. Uninstall the standalone plugin — this one
contains its functionality.

### The Output button resolves from the job store, not just the card

The **Output** button on a `job_output` card and the **job list in the header** open
the same modal, but they used to resolve the job along completely different paths:

| | source of the job id |
| --- | --- |
| header row | the session job **store** (`sessions.list` / the jobs route) |
| card Output button | a parse of the card's own `ioText` markup |

So when that parse failed, the button did **nothing at all** — no modal, no message —
while the header kept working perfectly. That is exactly the reported symptom.

`resolveCardJobId()` now tries the card first and then falls back to the same store
the header uses: card dataset → command text matched against the job store → the only
live job when there is exactly one → otherwise **nothing**. It never guesses between
two candidates, because opening the wrong job's output is worse than saying so. When
resolution fails the dialog opens with an honest explanation instead of the button
being silently dead, and the click logs its `source`:

```
[dsh-better-uiux] Output button clicked {"jobId":"pwsh-1","callId":"…","source":"command","opened":true}
```

`source` is `card`, `command`, `command-prefix`, `only-live-job`, or `unresolved`.

### ONE module per bundle — the shell only applies the first

The shell runs `apply()` for a package's **primary module only**. A bundle that
registers two modules gets the second one *installed and never started*:

```
__DSH_BETTER_UIUX__            -> object    (core applied)
__DSH_BETTER_UIUX__.liveState  -> undefined (live module NEVER applied)
```

That was a shipped bug with a perfectly misleading symptom: no live-terminal style
tag, no Output/Stop buttons, no header dot, clicking a job row did nothing — while
the host half streamed the job output flawlessly. Both original plugins registered
exactly one module each, so neither ever showed it.

`build.mjs` therefore **inlines** `live-terminal.js` into the core module's factory
instead of concatenating two registrations, and the core's `apply` calls it:

```js
exports.__liveTerminal = liveTerminalModule;   // exposed by the merge
// ...at the end of core's apply():
exports.__liveTerminal.apply(ctx);
```

`live-terminal.js` keeps its own `__ModuleLoader__.load` wrapper so it stays
readable and testable on its own; the build strips that wrapper (renaming its
`exports` to `liveExports` so it cannot collide with the core's). The build fails
loudly if a marker it needs is missing, and both `syntax-check.mjs` and the wiring
test assert the bundle registers **exactly one** module.

Both halves publish `__internals`, and the live half is inlined **second**, so a
plain assignment would replace the core's internals and silently delete `anchorState`
and the fork helpers. The build merges them with `Object.assign` instead.

`__DSH_BETTER_UIUX__.liveState()` reports whether the live half actually started —
`{ installRan, liveActive, wantLiveTerminal, isEnabled, modalSupported, hasSessionsService, styleTagPresent }`.
It exists because "the module never loaded" and "the module loaded but never
started" look identical from the outside and have completely different fixes.

### One route protocol between the two halves

The two halves talk over HTTP, so their route prefixes must match exactly. The ported
live-terminal browser half originally still called `/api/live-terminal/*` — the
**standalone** plugin's namespace — while the merged host half serves
`/api/better-uiux/*`. The mismatch failed in the least helpful way possible:

| | |
| --- | --- |
| host | captured output correctly (`/api/better-uiux/output` → 3434 chars, 42 lines) |
| client | fetched `/api/live-terminal/output` → **401 unauthorized** |
| result | *"the switch is on but the output never appears"* |

Nothing logged an error, because a 401 from a route owned by something else looks
exactly like a route that was never going to work. Two guards now exist:

- the **porter** re-points the routes as its last step, so a re-port cannot
  reintroduce the old prefix;
- the **host** registers the three live routes a second time under
  `/api/live-terminal/*`, sharing the very same handler functions (asserted by
  identity in the host test), so a client cached from before the fix still works
  instead of silently receiving nothing.

`/config` is deliberately **not** aliased — it never had a legacy name.

## Where the Edit button goes

The **Edit** button is injected into the shell's own `MessageIconActions` row — the
row that already holds the clock and the copy button — **to the right of copy**, and
it is **always visible** rather than hover-revealed:

```
[ 18:02 ]  [ copy ]  [ ✎ Edit ]
```

It carries DSH's **own** edit icon — `IconEditOutline16` (`ic_ds_edit_outline_16`)
from `@deepseek-ai/dsh-client-ui-primitives`, copied verbatim: a 16×16 box with a
single **filled** path (`fill="currentColor"`, not a stroked 24-box glyph), plus the
underline sub-path. Using the native glyph rather than a lookalike is what makes
the injected action indistinguishable from the actions beside it; an earlier
version approximated it with Lucide `square-pen` and the weight was visibly off.
The markup is inlined as a literal rather than `require`-ing the primitives
package, because this module must not depend on the shell's internal export
surface — so if DSH restyles the icon, that one string is what to update.

The button is an inline-flex 16px box with no padding, so it occupies exactly the
same slot shape as its neighbours.

### Making it always visible

Setting `opacity: 1` on the button is **not** enough, and that is the trap: the
shell fades the whole `_actions` row, not the children, so a child can never
out-render its parent's opacity. There are two fade paths to beat:

```css
/* the row is faded while the pointer is elsewhere ... */
[data-actions-reveal=hover] .qJxi1G_actions { opacity: 0; transition: opacity 80ms }
/* ... and on every user message that is not the last one */
:is([data-chat-flow-kind=user]):has(~:is([data-chat-flow-kind=user])) .qJxi1G_actions { opacity: 0 }
```

So the row itself is held open, scoped to rows that carry our host class:

```css
.dsh-bu-edit-host [class*="_actions"] { opacity: 1 !important }
```

Scoping it to `.dsh-bu-edit-host` matters: it applies only to rows this plugin has
decorated, and stops applying the instant **Edit message** is switched off or the
editor is torn down. The side effect is that the row's other actions (copy, the
clock) are visible on those messages too — unavoidable, since visibility is a
property of the row.

The row is located **relative to the shell's own copy button**, never by class name:
the wrapper's class is a CSS-module hash (`qJxi1G_actions`) that changes on every
DSH rebuild, so hard-coding it would silently stop matching. Lookup order:

1. a button whose `aria-label` is the shell's copy/copied text, read from
   `@deepseek-ai/dsh-client-locale` COMMON_NS (`Copy`/`Copied`, `复制`/`复制成功`),
2. any labelled button in the row (covers a shell that swaps the glyph),
3. any element whose class looks like the module's `_actions` wrapper.

The insertion point is the copy button's `nextSibling`, so the button lands
immediately right of copy whatever else the row holds. When there is no copy button
to anchor on it falls back to just after the clock (`_timeStart` / `_timeEnd`, the
module's own key names, which survive a rebuild even though the hash prefix does
not), then to the end of the row. If there is no icon row at all it falls back to
the message bubble, so the affordance is never lost.

A `conversation.chat.node` re-render can replace the row wholesale; each scan
re-homes the existing button into the fresh row instead of adding a second one.

## How edit-and-resend works

A DSH transcript is a fold over an **append-only event log**. Nothing in the
supported API rewrites a committed message: this build exposes no
`rewind` / `regenerate` / `editMessage`, the queue's `{kind:"edit"}` action only
reaches messages that have *not* been sent yet, and the gateway's only
history-shaping remote method is `session.fork`.

So "edit and resend" is implemented as the honest thing the platform supports — a
**branch**, never an in-place rewrite:

1. The `conversation.chat.turnTail` chain slot reports `{ turn, seq }` for every
   rendered turn; the plugin keeps `turn → closing seq`.
2. Editing a message in turn *N* calls
   `sessions.fork({ sessionId, atSeq: closingSeqOf(turn N-1), increaseTitle: true })`.
   The host resolves `atSeq` to *the first `turn/end` at or after it* and cuts the
   child right after that boundary, so the child carries everything **before** the
   message being replaced.
3. The child session is opened and receives the rewritten text via
   `session.prompt([{ type: 'text', text }], 'queue')`.

Consequences, all surfaced in the Settings note:

- the original session is **untouched**; you get a new session id (nested under the
  original by lineage, title incremented)
- the branch point must be a **completed** turn. Editing the *first* message of a
  session has no completed turn before it and is not possible — the button reports
  that instead of guessing
- if the fork fails for any other reason (e.g. the turn is still open), the plugin
  says so and offers a send into the current session as a fallback rather than
  silently doing nothing

The raw-JSONL route (decompress `session.jsonl.zstd`, drop trailing events,
recompress, force a reload) was deliberately **not** taken: it crosses unsupported
internals — torn-write repair markers, positional sequence numbers, projection
caches — and risks corrupting a session.

## Modal vs. the real composer

The edit dialog has **two** actions, because they solve different problems:

| Action | What it does | Composer features (@, /, attachments) |
| --- | --- | --- |
| **Save & resend** (primary) | forks the session and resends the rewritten text there — a true re-run from that point | ✗ — it is a plain prompt |
| **Fill into composer** | writes the text into the real composer and focuses it, then closes | ✓ — you finish the edit there |

The reason for the split: a true re-run needs the fork, and the fork consumes the
text programmatically — there is no way to hand a *fork* to the composer. So pick
per edit: use the composer when the rewrite needs `@`-mentions, `/` commands or
attachments, and the branch when it needs to actually re-run from that point.
Sending from the composer appends a **new** message to the current session; the
modal says so.

**Can the composer be embedded in the modal?** No. It is a singleton bound to one
DOM seat, over a session-scoped Lexical editor that the shell swaps into that seat
once, and its slot (`conversation.composer.bar`) is `kind: "single"` — a plugin
registering there would have to *shadow* the native input bar. What the plugin does
instead is write through the same public channel the shell itself uses:

```js
// conversation service, injected like any other
const actx = sessions.binding(sessionId).ctx;   // session-scope context
const shell = conversation.input.for(actx);     // SessionInputShell
shell.actions.setDraft(text);                   // replace draft, caret at end
// shell.actions.submit() would be the equivalent of pressing send
```

`setDraft` is the documented programmatic-write path — the persisted-draft seed
uses it — so this is an API call, not a DOM hack. The lookup is defensive at every
step (missing service, missing binding, missing `setDraft`, a throwing `setDraft`)
and reports the reason inside the dialog instead of failing silently.

## The fork anchor, and why it is learned rather than assumed

The cut has to land on the turn **before** the edited message: the host resolves
`atSeq` to "the first `turn/end` at or after it", so anchoring on the edited turn's
own closing seq would cut *after* it and leave the old text in the branch.

Anchors come from the `conversation.chat.turnTail` chain slot, which is handed
`{ turn, seq }` per turn. That map is populated **at render time**, so it is not
guaranteed to contain every turn — a turn whose tail never rendered in this page
session is simply absent. Reported in the wild as:

```
Branching failed, so this went in as a NEW message in the current session instead.
(no completed turn before the edited message)
```

The lookup is therefore a small resolver, not a single `get`:

```js
const exact = turnEndSeq.get(turn - 1);          // preferred
if (exact !== undefined) return exact;
// otherwise: the largest known anchor BELOW turn
for (const [knownTurn, seq] of turnEndSeq) {
  if (knownTurn >= turn) continue;               // never cut too late
  ...
}
```

Two properties matter:

- **never too late** — an anchor at or after `turn` would leave the message being
  replaced inside the branch, so those are excluded outright;
- **too early is acceptable** — anchoring on an earlier turn only carries extra
  context into the branch, which is a far better failure mode than not branching at
  all. That is why a gap in the map no longer degrades to the append fallback.

When nothing usable is known, the error names the anchor turn *and* what was known,
so a missing probe is distinguishable from an off-by-one turn number:

```
no anchor for turn 2 (edited turn 3; known anchors: none - the turn anchor probe has not run)
```

Live state is readable from DevTools, because the anchor map is the one piece of
runtime state that cannot be reasoned about from the source:

```js
__DSH_BETTER_UIUX__.anchorState()
// { anchors: { 1: 10, 2: 20 }, editorRunning: true, anchorSessionId: '…', editorScopeSessionId: '…' }
```

## The fork API shape (a bug that looked like a design flaw)

`sessions.fork()` is `ClientSessions.fork`. It **resolves to the child id string**
and **throws `SessionForkError`** on failure — it does not return an `{ok, value}`
envelope.

The first version of this plugin read it as an envelope:

```js
const forked = await sessions.fork({ sessionId, atSeq: previousSeq, increaseTitle: true });
const childId = forked?.ok === true ? forked.value?.sessionId : null;   // <-- always null
if (childId === null) throw new Error('fork failed');
```

`forked` is a string, so `forked.ok` is `undefined`, so `childId` was **always
null**, so every single edit threw and fell through to the "send into the current
session" fallback. The user-visible symptom was unmistakable and easy to
misdiagnose as a product decision: *editing a message appended it to the queue
instead of replacing anything.* Nothing about the fork logic was wrong — the
anchor arithmetic, the cut point, the child hand-off — only the shape of one
return value.

The fix reads it for what it is:

```js
const childId = await sessions.fork({ sessionId, atSeq: previousSeq, increaseTitle: true });
if (typeof childId !== 'string' || childId.length === 0) {
  throw new Error('fork did not return a child session id');
}
```

`tests/edit-fork-test.mjs` drives the real `resendEditedMessage` against a
scriptable sessions service and asserts the child gets the prompt while the
current session gets nothing. It has been validated by restoring the bug:

```
FIXED source                    -> 25/25 passed
ORIGINAL envelope reading       -> fails: "a legitimate fork does not throw"
                                   + every downstream assertion in section 1
```

The wiring contract additionally forbids the envelope shape in code (comments
stripped, so the doc comment naming the bug does not trip it).

## What "edit" actually does to your conversation

The log is append-only, so the platform **cannot** rewrite a turn in place: there
is no `rewind` / `regenerate` / `editMessage`, and the queue's `{kind:"edit"}` only
reaches messages that have not been sent yet.

But the observable outcome people actually want — *"I edit turn 3 of 5, so turn 3
is replaced and turns 4 and 5 are gone"* — is reachable with two supported calls:

1. **`sessions.fork({ atSeq: closingSeqOf(N-1) })`** cuts a prefix ending exactly
   where the edited message begins. Removing every later turn *is* what the cut
   does; it is not a separate cleanup step.
2. **`sessions.delete(originalId)`** retires the source session, so the dead-end
   tail does not sit in the session list beside the live branch.

Step 2 is exposed in the edit dialog as a checkbox, **on by default**:

```
[x] Delete the old session (drops every turn after this message)
```

It is a checkbox rather than a silent side effect because step 2 **destroys data
permanently** while step 1 only creates it. Unticking it keeps the old session —
useful for comparing, and the safe option when unsure. The choice is remembered
for the rest of the page session.

Either way the view follows the branch, so the edited message is the last thing
you see:

| | |
| --- | --- |
| cut point | the closing seq of turn *N−1* |
| branch | a new session titled `<old title> (2)`, holding everything before the edit |
| the edited text | sent to the branch |
| the original | **deleted** when the box is ticked, otherwise left untouched |
| ordering | fork → open child → send text → *then* delete, so the view never points at a session that just vanished |
| a failed delete | reported as a partial success — the branch is live and holds your text, and the reason (e.g. `session-busy`) is shown rather than swallowed |

### A failed branch changes nothing

There is **no automatic fallback**. If branching fails, the dialog reports the real
reason and leaves your text untouched in the box:

```
Could not branch, so nothing was changed. Use "Fill into composer" if you want it
as a normal message instead. (turn-open: the turn is open)
```

This is deliberate, and it replaced behaviour that was actively harmful: the edit
path used to catch a failed branch and quietly append the message to the current
session instead. Every branch failure therefore looked like *"my edit got added as a
new message"* — indistinguishable from a broken feature, and it destroyed the thing
the user was trying to do. Reporting and changing nothing is the honest failure.

Appending is still available, but only as a choice you make: the **Fill into
composer** button hands the text to the real composer, where you can send it as-is,
edit it further, or add `@`-mentions and `/` commands first.

## Startup activation (a reload-only bug worth remembering)
Features are activated from `loadFromHost()`, in its `finally`, **unconditionally**.

It used to be gated on "the host config differs from the cached one":

```js
const changed = JSON.stringify(next) !== JSON.stringify(config);
...
if (changed) syncFeatures();     // <-- wrong
```

That is true on a first run, and **false on every reload** — where the cache and
the host answer are identical. So nothing was activated on a reload: the Edit
button simply was not there. Touching any switch in Settings fixed it until the
next reload, because that path goes through `commit()`, which calls
`syncFeatures()` directly. The failure looked like "the feature is broken",
when in fact the feature had never been started.

The fix is to treat activation as part of startup rather than as a change
reaction. `syncFeatures()` is idempotent (`startMessageEditor` /
`stopMessageEditor` return early when already in the requested state), so calling
it once on every startup is free.

`tests/startup-activation-test.mjs` guards this, and it is worth knowing that the
first version of that test **did not** catch the bug — it passed against the
broken code. The reason is instructive: the test's DOM stub only matched
descendants of the document root, and the fake row hung off `<body>`, so the row
was never found and the assertion was failing for the wrong reason. The stub was
fixed, and the test was then validated the only way that means anything — by
restoring the bug and checking the test goes red:

```
FIXED source          -> 9/9 checks passed
ORIGINAL BUG restored -> 7/9, failing exactly:
                         the message editor was started — no MutationObserver was installed
                         the user row got an Edit button — found 0
```

A test that has never been seen to fail is not evidence.

## Storage and HTTP surface

Config lives at `$DSH_HOME|~/.dsh` + `/plugins/dsh-better-uiux/config.json`, and is
mirrored in `localStorage` (`dsh_better_uiux_config`) so state is correct before the
host answers. Only the three flags and the CSS string are persisted.

| Route | Purpose |
| --- | --- |
| `GET/POST /api/better-uiux/config` | read / update `{ features, css }` |
| `GET /api/better-uiux/jobs` | background jobs with live status |
| `GET /api/better-uiux/output` | live output for a job or a foreground process |
| `GET /api/better-uiux/stop` | stop a job, a process, or a pending `job_output` wait (`?mode=wait`) |

The three terminal routes answer `{ success: true, enabled: false, ... }` while the
live-terminal switch is off.

## Layout

```
index.js            host half: config store + live-terminal host hooks + routes
core.js             client: config store, Better UIUX Settings section, custom CSS, message editor
live-terminal.js    client: live terminal port, gated on the switch + full teardown
client.js           GENERATED: core.js + live-terminal.js concatenated
build.mjs           the concatenation step (see below)
local-install.mjs   status / install / uninstall against the DSH web profile
syntax-check.mjs    parse gate for every shipped artifact
tests/              render, wiring contract, host smoke, config-store edge cases
```

### Why a build step

The DSH client module loader composes **one** client bundle per package
(`exports["./client"]`), and that single artifact is what the shell serves as
`/plugins/dsh-better-uiux/client.js`. Two files would mean the second never loads.
This plugin is genuinely two modules, so `node build.mjs` concatenates them into
that one artifact; each part calls `window.__ModuleLoader__.load` and they resolve
each other through `globalThis.__DSH_BETTER_UIUX__` at runtime.

`live-terminal.js` is itself generated from the original plugin by
`../_patches/port-live-terminal.mjs`, which applies the feature gate and the
teardown. Edit the porter (or the merged file directly) rather than re-porting by
hand.

## Install / uninstall (local dev)

```pwsh
node build.mjs                  # regenerate the served bundle first
npm run install:local           # junction into the web profile + register it
npm run status:local            # what is currently installed, and where
npm run uninstall:local         # remove plugin, junction, manifest entries AND data
```

`local-install.mjs` derives every path from its own location (and `DSH_HOME` /
`APPDATA`), so a moved or renamed checkout still manages itself.

The package is installed as a **directory junction**, so edits in this checkout are
live without reinstalling. That is deliberate and also the one real hazard: a
junction must be removed with `rmdir` (unlink the entry), never with a recursive
delete — on Windows a recursive delete follows the link and destroys the checkout it
points at. `uninstall` uses `rmdir` and then asserts `client.js` still exists.

`uninstall` also deletes the settings data at
`<harness>/plugins/dsh-better-uiux/`. It copies `config.json` to
`%TEMP%/dsh-better-uiux-removed-data/` first, so a removal stays reversible.

`install.ps1` is the alternative for a non-junction, pnpm-managed install
(`pwsh -File .\install.ps1`, `-Link` for a junction, `-Remove` to uninstall).

### The one thing that lives outside this checkout

The browser mirrors the config in `localStorage` under `dsh_better_uiux_config_v2`.
Uninstall cannot reach it. To clear it in DevTools:

```js
localStorage.removeItem('dsh_better_uiux_config_v2');
```

After a fresh install with no config file, the shipped defaults apply:
**live terminal on, custom CSS on, edit message off** (opt-in), empty CSS.

## Verify

```pwsh
node build.mjs                              # regenerate the bundle
node syntax-check.mjs .                     # both artifacts parse
node tests/stylesheet-integrity-test.mjs    # 11 checks: the CSS template is intact
node tests/render-section.mjs               # renders the Settings pane with real React
node tests/client-wiring-test.mjs           # 84 wiring/contract assertions
node tests/edit-placement-test.mjs          # 18 checks: Edit sits between time and copy
node tests/edit-fork-test.mjs               # 65 checks: fork, retire, order, and no-append-on-failure
node tests/startup-activation-test.mjs      # 9 checks: features start on EVERY reload
node tests/composer-fill-test.mjs           # 19 checks: the composer write path
node tests/host-smoke-test.mjs              # 32 host behaviour assertions
node tests/config-edge-test.mjs             # 8 config-store edge cases
```

`stylesheet-integrity-test.mjs` exists because of a real bug: the section's
stylesheet is a **template literal**, so a backtick inside a CSS comment ends it
early and turns the rest of the stylesheet into code. That failed as a confusing
runtime `TypeError` whose message was a chunk of CSS. The test asserts the literal
terminates where it should, contains no `${`, and ends after a closing brace.

`tests/render-section.mjs` catches the failures users actually see. It loads the
bundle, captures the registered section, and renders it through the DSH app's own
React with the props kit the slot renderer hands it — then fails if the pane renders
its error face, if a locale key leaks into the markup, or if a dictionary value is
not a string. It reproduced the shipped `template.replace is not a function` bug
before that was fixed, so keep it green.

That bug is worth knowing: `ctx.locale.register` values **must be strings**. The
runtime interpolates with `template.replace(/\{(\w+)\}/g, …)`, so a function (or any
non-string) throws, the shell swallows it, and the pane goes blank.

`host-smoke-test.mjs` drives the real `apply()` against a fake context and a
throwaway `DSH_HOME`: route registration, config round-trip and persistence, feature
gating, and that the subprocess wrapper records nothing while off.

`config-edge-test.mjs` guards the failure modes that only show up in a real install:
a **UTF-8 BOM** in `config.json` (added by an editor or `Set-Content`) must not reset
every switch — `JSON.parse` rejects a BOM, so the reader strips it — an explicit
`false` on disk must survive, an absent key must take the shipped default, and a
corrupt file must fall back to defaults rather than throwing.

`client-wiring-test.mjs` asserts the contract between the browser pieces — module
ids, slot names, fork sequencing, teardown targets, and the dictionary rules above.

### Manual checklist

1. **Settings → Better UIUX** opens a page with three switches and the CSS editor.
   A blank pane means a render error: the section wraps itself in its own boundary
   and prints the message and stack **inside the pane**, plus
   `[better-uiux] client v… initialized` in the console.
2. Switch on **Custom CSS**, paste `:root { --dsw-alias-brand-primary: #22d3ee; }`,
   and confirm the accent changes as you type; reload and confirm it is still on.
3. Switch on **Live terminal output** and run a command — the live block, pulsing
   dot, Copy / Stop and the output modal appear. Switch it **off** and confirm every
   injected block, dot, footer row and the modal disappear with no layout damage.
4. Switch on **Edit message**, hover a user message from turn 2 or later, click
   **Edit**, rewrite, **Save & resend**. Expect a new branched session containing
   the edited text and ending at your edit — every later turn is gone. With the
   checkbox ticked the original session is deleted; untick it and the original
   survives, unchanged and intact.

## Known limits

- Editing the first message of a session is not possible (no completed turn to fork
  from) — the note in Settings explains why.
- The replaced turns are removed by **deleting the source session**, not by
  truncating a log. There is therefore no partial undo: either the old session is
  gone or it is whole. Untick the checkbox to keep it.
- Deleting a session that the host still considers busy fails (`session-busy`). The
  branch is already created and holds your text at that point; the dialog reports
  the failed retire rather than pretending the edit did not happen.
- The forked child is created from the current default model selection, which may
  differ from the edited session's own selection.
- Buttons are injected into the rendered transcript by a `MutationObserver`, because
  DSH exposes no per-message user-action slot (`conversation.chat.assistant-actions`
  exists for assistant messages only). If a future DSH release changes the user
  message DOM, the Edit button is what breaks — not your transcript. The button is
  re-homed onto the current action row whenever the row is replaced, so a re-render
  cannot silently discard it.
- A `config.json` written by an editor that adds a BOM is tolerated; any *other*
  corruption falls back to the shipped defaults (live + css on, edit off), which is
  why a bad config shows up as the stock state rather than as an error.
- The live-terminal port keeps a 1 Hz jobs poll installed but gated, so a
  switched-off feature costs one no-op call a second.
- Running the standalone `dsh-plugin-live-terminal` alongside this plugin fights over
  the same DOM nodes; the plugin warns about it but cannot prevent it. Uninstall it.
