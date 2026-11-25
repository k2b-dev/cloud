# Migration guide

A growing reference document for coding agents and human developers upgrading
between releases of `@k2b/stdlib`. Each version section lists exactly
what to change in consumer code, what to grep for, and concrete diff examples.

When upgrading by more than one version, work through the sections in order
(oldest → newest). Each section is independent.

---

## Package scope migration

Starting with v0.17.0, the package and repository moved:

- npm: `@valentinkolb/stdlib` -> `@k2b/stdlib`
- GitHub: `ValentinKolb/stdlib` -> `k2b-dev/stdlib`

All entry points and public APIs remain the same. Replace the package scope in
dependencies and imports:

```diff
-import { dates } from "@valentinkolb/stdlib";
-import { files } from "@valentinkolb/stdlib/browser";
+import { dates } from "@k2b/stdlib";
+import { files } from "@k2b/stdlib/browser";
```

The old npm package is deprecated and receives no further releases.

After v0.36.0 the source moved again, without a package change: `@k2b/stdlib`
is developed in `packages/stdlib` of `k2b-dev/cloud` and released from there
(tags `npm-stdlib-vX.Y.Z`). Report issues in `k2b-dev/cloud`. Consumers change
nothing.

---

## v0.7 → v0.8 (audit / non-breaking sweep)

Released 2026-05-11. A comprehensive correctness + security audit. All API
changes are **additive**; no existing call site needs to change to keep
working. However, several silent-failure paths now throw loud errors that
caller error handling may need to catch, and a handful of behaviors were
corrected in observable ways. Use this section to find and review affected
call sites.

### TL;DR (1 minute scan)

Grep your codebase for these patterns. If you find one, read the matching
sub-section below.

```bash
# Crypto: forward `v` from sign() output through to verify()
grep -rn "asymmetric\.sign\|asymmetric\.verify" src/

# kvStore: surface previously-silent failures
grep -rn "kvStore\.set\|kvStore\.clear\|kvStore" src/

# Date URLs: parseCalendarDate now returns local-midnight
grep -rn "parseCalendarDate\|formatDateKey\|getMonthGrid\|getDateRange" src/

# Detail-panel: pushState by default
grep -rn "detailPanel\.setUrlParam\|setUrlParam" src/

# TOTP: throws on bad secret
grep -rn "totp\.verify" src/

# DnD CSS selectors: aria-grabbed is deprecated
grep -rn "aria-grabbed" src/ styles/ public/

# Untrusted Base64 input: opt into the strict decoder
grep -rn "fromBase64\b" src/

# Dropzone: text drags no longer trigger isDragging
grep -rn "dropzone\.create" src/
```

### 1. `crypto.asymmetric.sign` returns a new `v: number` field

**What changed:** `sign()` now returns `{ nonce, timestamp, signature, v: 2 }`.
The `v` field signals which payload-serialization format was used. Existing
destructuring (`const { signature, nonce, timestamp } = sig`) keeps working.

**Why:** v1 used `${nonce}:${message}:${timestamp}` concatenation, which
allowed a field-boundary attack where one signature could be re-interpreted
with shifted field boundaries. v2 uses length-prefixed serialization.

**What to change:** When forwarding the signature object to another service
or storing it for later verification, include the `v` field. The recommended
pattern is to spread the whole object:

```ts
// Before
const sig = await crypto.asymmetric.sign({ privateKey, message });
sendToServer({
  signature: sig.signature,
  nonce: sig.nonce,
  timestamp: sig.timestamp,
});

// After
const sig = await crypto.asymmetric.sign({ privateKey, message });
sendToServer({ ...sig }); // include `v`
```

**Verification side:** With `v` forwarded, `verify()` uses v2-only and is
immune to the field-boundary attack. Without `v`, verify falls back to
trying both formats for backward compatibility — same security as v1.

For new security-critical paths, also set `strict: true`:

```ts
const valid = await crypto.asymmetric.verify({
  ...sig,            // includes v: 2
  publicKey, message,
  strict: true,      // rejects legacy v1 + high-S ECDSA signatures
});
```

### 2. `crypto.asymmetric.verify` validates `maxAge`

**What changed:** Passing `maxAge: NaN`, `Infinity`, or `<= 0` now throws
`TypeError`. Previously these silently disabled the expiration check.

**What to change:** Make sure `maxAge` comes from a validated source, or
provide a finite fallback. Most call sites are unaffected because they use
the default (no `maxAge` passed).

### 3. `crypto.totp.verify` throws on malformed secret

**What changed:** A malformed Base32 secret (typos, leftover whitespace,
non-Base32 characters) now throws an error. Previously this was silently
returned as `false`, indistinguishable from a wrong token.

**What to change:** If you accept secrets from external sources (URL params,
config files), wrap the call:

```ts
try {
  const valid = await crypto.totp.verify({ token, secret });
} catch (e) {
  // Programmer error: malformed secret. Surface this as a configuration
  // problem, not as "user entered wrong token".
  console.error("Invalid TOTP secret format:", e);
}
```

Also: `window` is now clamped to a max of 10 (RFC recommends 1). Passing
larger values is silently capped. Negative or non-finite `window` throws.

### 4. `kvStore.set(key, undefined)` throws

**What changed:** Setting a top-level `undefined`, function, or symbol value
now throws `TypeError`. Previously this left a corrupt half-state where
`has(key)` was `true` but `get(key)` returned `undefined`.

**What to change:** Use `kvStore.delete(key)` to remove an entry:

```ts
// Before (silently broken)
await kvStore.set("config:flag", isEnabled || undefined);

// After
if (isEnabled) await kvStore.set("config:flag", true);
else          await kvStore.delete("config:flag");
```

### 5. `kvStore` corrupt index now throws

**What changed:** A corrupt on-disk index file now throws an Error on the
first store access. Previously the store silently reset to empty, orphaning
every existing blob in OPFS.

**What to change:** If your app does anything important with kvStore, add a
top-level error handler so corruption is visible rather than data-losing:

```ts
try {
  const userData = await kvStore.get("user:current");
} catch (e) {
  if (String(e).includes("corrupt")) {
    // Recovery flow: notify user, attempt re-init from canonical source.
    await kvStore.clear();
  } else {
    throw e;
  }
}
```

### 6. `kvStore.destroy()` is a new public method

**What changed:** New API to tear down module-level state + close the
BroadcastChannel. Useful in tests (call in `afterEach`) and for explicit
shutdown.

**What to change:** Nothing required. Recommended addition in test setup:

```ts
afterEach(() => kvStore.destroy());
```

### 7. `kvStore.clear()` propagates non-NotFound errors

**What changed:** Previously `clear()` swallowed all OPFS errors. Now only
`NotFoundError` (the legitimate "already empty" case) is swallowed; quota
errors, permission errors, etc. propagate.

**What to change:** If your app routinely catches errors from operations
near `clear()`, no change needed — those errors are now surfaced from
`clear()` itself.

### 8. `kvStore.set` / `setBytes` write-before-delete order

**What changed:** Old blobs are deleted **after** the new value is durably
written. Previously a quota-exceeded error during write left the previous
value already deleted.

**What to change:** Nothing — purely a correctness fix.

### 9. `detailPanel.setUrlParam` now defaults to pushState

**What changed:** Selecting items now creates Back/Forward history entries.
Previously every selection silently replaced the current entry, breaking the
documented URL-synced contract.

**What to change:** If you have an explicit caller for the **initial** URL
sync from query-params (where you don't want a history entry), add the new
`mode` argument:

```ts
// On initial mount
detailPanel.setUrlParam("user", initialUserId, "replace");

// On user-driven selection (default — adds history entry)
detailPanel.setUrlParam("user", selectedUserId);
```

### 10. `dates.parseCalendarDate` returns local-midnight

**What changed:** Previously `parseCalendarDate("2025-03-05")` parsed as
UTC midnight. In negative-offset timezones (e.g. America/Los_Angeles), the
returned date's `.getDate()` was 4, not 5 — silently breaking calendar URLs
throughout the Americas.

Now: always returns local-midnight of the given calendar day.

**What to change:** Nothing for correct call sites. Audit tests if you have
hard-coded `new Date("2025-03-05")` (UTC) values being compared against
`parseCalendarDate` output — those need to use local construction
(`new Date(2025, 2, 5)`) to match.

### 11. `dnd` — `aria-grabbed` is deprecated, use `data-dnd-active`

**What changed:** `aria-grabbed` was removed from ARIA 1.2 and is ignored by
modern screen readers. The library still emits it for backward compatibility
but **also** now emits `data-dnd-active="true"/"false"` reactively. Future
versions will remove `aria-grabbed` entirely.

**What to change in CSS:**

```css
/* Before */
[aria-grabbed="true"] { /* dragging state */ }

/* After */
[data-dnd-active="true"] { /* dragging state */ }
```

**Accessibility:** Use the `announcements` option on `dnd.create({...})` to
provide screen-reader-friendly state. The library already wires this up to
an off-screen ARIA live region.

**Touch scrolling:** Draggables no longer receive `touch-action: none`
unconditionally because that prevented native scrolling across mobile lists.
Apply `touch-action: none` to a dedicated drag handle, or set the draggable's
`touchAction: "none"` option when disabling pan/zoom for the whole element is
intentional.

### 12. `dropzone` only fires `isDragging` for actual file drags

**What changed:** Plain text/link drags no longer trigger the file-drop UI.
The library now requires either `dataTransfer.types.includes("Files")` OR
at least one `DataTransferItem` with `kind === "file"`.

**What to change:** Nothing for correct call sites. If you had a workaround
suppressing UI based on the result of `onDrop`, you can remove it.

### 13. `encoding.fromBase64Strict` is the new opt-in for untrusted Base64

**What changed:** `fromBase64` is unchanged (lenient — Bun/Node accept
garbage; browser is strict). Added `fromBase64Strict` that validates the
alphabet, padding placement, and length-multiple-of-4 cross-runtime.

**What to change:** Use `fromBase64Strict` for inputs you don't control:

```ts
// User-provided / URL / network input
const bytes = encoding.fromBase64Strict(input); // throws on garbage
```

### 14. `charts.histogram` clamps `bins` at 1024

**What changed:** `bins: 1e9` previously attempted gigabyte-scale
allocation. Now clamped at 1024.

**What to change:** Nothing — purely a safety cap.

### 15. New gotchas worth knowing (no code change required)

- `mutation`: concurrent in-flight mutations no longer overwrite newer
  results. Slow-resolving older calls are silently dropped.
- `mutation`: `AbortError` thrown by your mutation function now routes to
  `onAbort`, not `onError`.
- `localStore`: malformed stored JSON or wrong `_key` falls back to default
  values instead of crashing.
- `charts` log axes: data points where `x` or `y` is ≤ 0 are now filtered
  before rendering (was: emitted huge off-plot SVG coordinates).
- `timing.buffer`: write that arrives during an in-flight flush is now
  preserved (previously the cache entry was deleted before the new value
  could land).
- `streaming.parseSSE`: handles CRLF split across chunk boundaries.
- `search-params.deserialize`: filters `__proto__`, `constructor`,
  `prototype` keys to prevent prototype pollution.

---

## v0.20 → next (i18n slice, breaking)

### 1. `text.pprintBytes` / `pprintBytesParts` take an options object

**What changed:** The positional mode argument was replaced by
`{ mode?, locale? }`; the numeric part can now be localized explicitly.

```ts
// Before
text.pprintBytes(1500, "si");
// After
text.pprintBytes(1500, { mode: "si" });
text.pprintBytes(1536, { locale: "de" }); // "1,5 KiB"
```

### 2. `dates` formatters take context objects only

**What changed:** `formatMonthYear`, `formatWeekdayShort`, `formatWeekdayLong`,
`formatFullDate`, `weekdays`, and `months` no longer accept a bare locale
string; `formatTimeSpan` no longer accepts a positional base argument.

```ts
// Before
dates.formatMonthYear(d, "de");
dates.formatTimeSpan(d, base);
// After
dates.formatMonthYear(d, { locale: "de" });
dates.formatTimeSpan(d, { base, locale: "de" });
```

### 3. Relative and duration output is now Intl-generated

**What changed:** `formatDateTimeRelative`, `formatDateRelative`, and
`formatDuration` render via `Intl.RelativeTimeFormat` / `Intl.NumberFormat`
(unit style) in the context locale (default `"en"`), instead of hardcoded
English.

**What to change:** Update exact-string assertions:
`"just now"` → `"now"`, `"4 mins ago"` → `"4 minutes ago"`,
`"Yesterday"` → `"yesterday"`, `"2 hours 30 minutes"` →
`"2 hours, 30 minutes"`, `"less than a minute"` → `"< 1 minute"`.
`formatDuration` additionally accepts a `DateContext`.

### 4. New APIs (non-breaking)

- `i18n` module: `define`/`resolve` message catalogs, `parseAcceptLanguage`,
  `plural`, `formatList`, `compare`.
- `dates.formatRecurrence` / `dates.formatRecurrenceParts`.
- `text.pprintCurrency`.

## v0.33 → v0.34 (Solid mutation status and concurrency)

### 1. A second `mutate()` while one runs is dropped

**What changed:** `mutation.create()` defaults to `concurrency: "drop"`. A
`mutate()`, `retry()`, or `run.retry()` while another call is `pending`
(`onBefore` running) or `loading` runs nothing, changes no state, runs no hook
(also not `onFinally`), and resolves `"dropped"`. Before, the newer call
superseded the running one.

**What to change:**

- Find mutations where the newest call must win, such as autosave, search as
  you type, drag reorder, or rapid toggles, and add `concurrency: "replace"`.
  That restores the old superseding behaviour.
- One mutation shared by many rows with different inputs (a delete or star
  button in each row) loses a click on row B while row A saves. Give each row
  its own mutation (one component per row) or use `concurrency: "replace"`.
- A local busy flag set before `mutate()` and released only in `onFinally`
  stays set when the call is dropped. Release it after the `await` (or in a
  `finally` around it) instead.
- Remove hand-written `if (!m.loading()) m.mutate(…)` guards where they only
  prevented double clicks.

```ts
const autosave = mutation.create({ concurrency: "replace", mutation: saveDraft });

// Busy flag: release after the call, also when it was dropped.
setBusy(true);
try {
  await toggle.mutate(id);
} finally {
  setBusy(false);
}
```

### 2. `mutate()`, `retry()`, and `run.retry()` resolve with the outcome

**What changed:** They resolve `"success" | "error" | "aborted" | "dropped" | "superseded"`
(type `MutationOutcome`) instead of `undefined`. A throw in `onSuccess` still
rejects.

**What to change:** Code that reads `error()` or `data()` right after
`await m.mutate(x)` must read the outcome: a dropped call leaves `error()`
empty and `data()` from an earlier run, so it would look like a success.

```ts
// Before
await update.mutate(values);
if (!update.error()) close();

// After
if ((await update.mutate(values)) === "success") close();
```

Functions typed `Promise<void>` that `return m.mutate(x)` now fail to
typecheck; `await` the call instead, or widen the type to `Promise<unknown>`.

### 3. `abort()` is a way out

**What changed:** `abort()` ends the call in flight at once: `status()` is
`aborted` synchronously and `onAbort` and `onFinally` run right away. While
`onBefore` is pending they run without a context, the hook's `signal` fires, and
a later `onBefore` result is ignored. While the mutation function runs, its late
result is discarded. `abort(); mutate(next)` starts `next` at once under `drop`,
also when the aborted function ignores its signal. The aborted caller gets
`"aborted"`, and its `onAbort` can roll back an optimistic change.

**What to change:** Nothing for `abort(); mutate(next)`; it works as before.
`onAbort` handlers must accept `ctx === undefined` (the type always allowed it).

### 4. Hooks run after the state is committed

**What changed:** `loading()` and the new `status()` are updated before
`onError` and `onAbort` run (as they already were before `onSuccess`). Inside
those hooks, `loading()` is now `false`.

**What to change:** Nothing, unless a hook read `loading()` and expected `true`.

### 5. `onError` receives a third argument

**What changed:** `onError(error, ctx, run)`; `run.retry()` repeats exactly the
failed call.

**What to change:**

- Wrappers that forward `onError` must pass all three arguments:
  `options.onError?.(error, ctx, run)`. A two-argument call fails with TS2554.
- Tests that assert `expect(onError).toHaveBeenCalledWith(error, ctx)` fail on
  the third argument. Use
  `toHaveBeenCalledWith(error, ctx, { retry: expect.any(Function) })` or check
  `onError.mock.calls[0]?.[0]`.

### 6. New APIs (non-breaking)

- `status()`: `"idle" | "pending" | "loading" | "success" | "error" | "aborted"`.
  Read it before `error()`: after an abort or `cancel()`, `error()` may still
  hold an earlier call's error.
- `settledAt()`: time of the last end, strictly increasing; `now` option for the
  clock. It follows the wall clock, so cap hold times computed from it.
- `onBefore(vars, { cancel })`: `return cancel()` ends the call as `aborted`
  without `onError`; `return` lets TypeScript narrow after it.

---

## v0.36 → next (charts removed, breaking)

**What changed:** The root entry no longer exports the chart module. Charts
live only in `@k2b/ui/charts`. Removed: the `charts` namespace; the functions
`scatter`, `line`, `bar`, `pie`, `donut`, `sparkline`, `histogram`, `boxplot`,
`gauge`, `barGauge`, `stat`, `heatmap`, `map` and `stateTimeline`; the helpers
`chartDatumSvg`, `svgRoot`, `escapeXml`, `normalizePadding`, `computeDomain`,
`niceStep`, `extendDomainToNice`, `mapRange`, `mapLog`, `niceLogTicks`,
`linearRegression`, `computeBoxStats`, `autoBin`, `linePathD`, `smoothPathD`,
`arcPathD`, `markerPath` and `stepPathD`; and the types `Point`, `Series`,
`MarkerShape`, `LineStyle`, `MapPoint`, `MapSeries`, `MapViewport`,
`MapOptions`, `BarItem`, `SliceItem`, `AxisOptions`, `Padding`, `ChartDatum`,
`ChartOptions` and `ReferenceLine`.

**What to grep for:** imports of these names from `@k2b/stdlib`.

**What to change:** Render interactive charts with `Chart` from
`@k2b/ui/charts`. For pure SVG on the server or in a script, import the same
names from `@k2b/ui/charts/core`; they keep their signatures and markup.

```diff
-import { charts, computeDomain } from "@k2b/stdlib";
+import { charts, computeDomain } from "@k2b/ui/charts/core";
```

<!-- Future version sections append here -->
