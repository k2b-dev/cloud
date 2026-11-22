# @k2b/stdlib

Generic TypeScript utility library -- crypto, encoding, dates, display helpers, files, images, and SolidJS primitives.

**Why?** I kept reimplementing the same micro-utilities across [my projects](https://github.com/ValentinKolb). This package consolidates them in one place with consistent APIs, thorough tests, and minimal dependencies.

> Package migration: `@valentinkolb/stdlib` is deprecated. Use `@k2b/stdlib` for all new installs and upgrades.

## Design goals

- **Native-first** -- modern browsers ship incredibly powerful APIs (Web Crypto, Intl, CompressionStream, OPFS, ...) but they tend to be verbose and awkward to use directly. This library wraps them into ergonomic, composable functions, using `dayjs` for IANA timezone calendar math and `big.js` for exact money arithmetic. QR and SolidJS stay behind optional peer dependencies (`lean-qr`, `solid-js`).
- **Tree-shakeable** -- the package declares `"sideEffects": false`, so bundlers keep only the root exports you use. Importing `i18n` alone does not pull in dayjs or big.js. If you use dayjs directly, register its `utc` and `timezone` plugins yourself; the date helpers only do this for their own use. Import from the entry point matching your runtime.
- **TypeScript-first** -- strict mode, full type inference, no `any`

## Installation

```bash
bun add @k2b/stdlib

# Install optional dependencies for QR and SolidJS helpers
bun add solid-js lean-qr
```

## Entry Points

| Import | Environment | What's inside |
|---|---|---|
| `@k2b/stdlib` | Universal | encoding, crypto, password, dates (incl. German public holidays), i18n, money, text, fuzzy, highlight, charts, cache, result, svg, timing, streaming, search-params, file-icons, gradients |
| `@k2b/stdlib/finance` | Universal, optional peers | DATEV CSV, [DATEV XML packages for Belegtransfer](docs/datev-xml.md), SEPA XML, [E-Invoice XML/PDF reading and XML generation](docs/einvoice.md) with [explicit payment rounding](docs/einvoice.md#explicit-payment-rounding-bt-114), and [camt.052 account report import](docs/camt.md); [formats, examples and runtime requirements](docs/finance.md) |
| `@k2b/stdlib/qr` | Universal (requires `lean-qr`) | qr -- WiFi/email/tel/vCard/event payload generators and SVG rendering |
| `@k2b/stdlib/browser` | Browser-only | files (OPFS, ZIP), images (canvas pipeline), cookies, clipboard, notifications, **kvStore** (OPFS-backed key-value, cross-tab `watch` subscriptions), theme |
| `@k2b/stdlib/bun` | Bun | `loadDatevXmlSchemas` for the [DATEV XML](docs/datev-xml.md) XSD check |
| `@k2b/stdlib/solid` | SolidJS | mutation, query, timed, hotkeys, dnd, detail-panel, localstorage, clipboard, click-outside, dropzone, a11y |

The split is by **runtime requirement**, not import preference: `browser` modules touch DOM/OPFS/BroadcastChannel and would crash in Bun/Node if imported from the root entry. Use the subpath that matches the environment you're targeting.

Since 0.36.0, monthly DATEV booking batches can link to separately transferred
images: set `DatevPosting.documentGuid` and transfer the same GUID with XML
`kind: "documentImage"`. See [Beleglink and image-only transfer](docs/datev-xml.md#transfer-images-and-link-monthly-bookings).

## Quick Start

### Process & Cache Images

```typescript
import { crypto, text } from "@k2b/stdlib";
import { images, kvStore } from "@k2b/stdlib/browser";

// Load, resize, and cache a user-uploaded photo
const img = await images.create(uploadedFile);
const processed = await Promise.resolve(img)
  .then(images.resize(800, 600, "cover"))
  .then(images.toBlob("webp", 0.85));

const hash = await crypto.common.hash(new Uint8Array(await processed.arrayBuffer()));
await kvStore.setBytes(`cache:${hash}`, new Uint8Array(await processed.arrayBuffer()));

console.log(`Cached ${text.pprintBytes(processed.size)} image`);
```

### Format Display Values

```typescript
import { text } from "@k2b/stdlib";

text.pprintNumber(1_234_567);                       // locale-aware grouping
text.pprintNumber(1_234_567, { compact: true });    // "1.2M" in an English locale
text.pprintPercent(0.999, { decimals: 3 });         // "99.900%"
text.pprintDurationMs(90_000);                      // "1m 30s"
text.pprintCurrency(1234.5, "EUR", { locale: "de" }); // "1.234,50 €"
text.pprintDurationMs(null, { fallback: "n/a" });   // "n/a"
```

### Calculate Exact Money

```typescript
import { money } from "@k2b/stdlib";

const net = money.parse("1.234,56", { locale: "de-DE", currency: "EUR" });
const { gross } = money.taxFromNet(net, { percent: "19", rounding: "half-up" });
money.format(gross, { locale: "de-DE" }); // "1.469,13 €"
money.allocate(money.fromMinor(100, "EUR"), [1, 1, 1]); // 34, 33, 33 cents
```

See [money](docs/money.md) for rounding rules, CSV input, credits and reconciliation.

### Translate Messages

```typescript
import { i18n, dates } from "@k2b/stdlib";

const catalog = i18n.define({
  baseLocale: "en",
  messages: {
    en: { greeting: ({ name }: { name: string }) => `Hello ${name}` },
    de: { greeting: ({ name }) => `Hallo ${name}` },
  },
});

// BCP-47 fallback: "de-AT" -> "de" -> "en"; no global state, SSR-safe
const { locale, t } = catalog.resolve(i18n.parseAcceptLanguage(header));
t.greeting({ name: "Ada" });          // "Hallo Ada"
dates.formatDate(date, { locale });   // same locale drives Intl-based formatting
```

### Generate IDs and Keys

```typescript
import { crypto } from "@k2b/stdlib";

const publicId = crypto.common.ulid();                       // sortable 26-char ULID
const batchId = crypto.common.ulid({ monotonic: true });      // ordered within the same millisecond
const requestId = crypto.common.uuid();                       // UUID v4
const supportCode = crypto.common.readableId();               // human-readable ID
const secretKey = crypto.common.generateKey();                // 256-bit hex key
```

ULIDs are sortable identifiers, not secrets. Their millisecond timestamp is visible; use `generateKey()` for reset tokens, API tokens, and encryption keys.

### API Data with Error Handling

```typescript
import { result, dates, cache, searchParams } from "@k2b/stdlib";

const userCache = cache.create<User>({
  ttl: 5 * 60_000,
  onMiss: async (id) => {
    const res = await result.tryCatch(() => api.fetchUser(id));
    return res.ok ? res.data : null;
  },
});

const user = await userCache.get("user:123");
if (user) {
  const timeZone = dates.normalizeTimeZone(user.timeZone, "UTC");
  console.log(`Last seen: ${dates.formatDateRelative(user.lastSeen, { timeZone })}`);
}

// Edit stored UTC instants in a user's timezone
const startsAtInput = dates.instantToZonedInput(event.startsAt, user.timeZone);
const startsAt = dates.zonedDateTimeToInstant(startsAtInput, user.timeZone);

// Sync filters to URL
const query = searchParams.serialize({ page: 1, active: true });
```

### Command Palette with Highlighted Matches

```typescript
import { fuzzy } from "@k2b/stdlib";

const commands = [
  { id: "open-file", label: "Open File" },
  { id: "save-doc", label: "Save Document" },
  { id: "user-settings", label: "User Settings" },
  // ... hundreds more
];

// Rank by fuzzy match, take top 10
const hits = fuzzy.filter("uss", commands, { key: c => c.label, limit: 10 });

// Render with <mark>-highlighted matched characters
for (const hit of hits) {
  const html = fuzzy.segments(hit.target, hit.ranges)
    .map(s => s.match ? `<mark>${s.text}</mark>` : s.text)
    .join("");
  // for "User Settings": "<mark>Us</mark>er <mark>S</mark>ettings"
}

// Did-you-mean typo correction
fuzzy.closest("primry", ["primary", "secondary", "tertiary"]);
// { value: "primary", distance: 1, similarity: 0.86 }
```

### Headless Syntax Highlighting

```typescript
import { highlight } from "@k2b/stdlib";

// Markdown preview for textarea overlays. Returns escaped HTML with semantic classes.
preview.innerHTML = highlight.markdown(markdownText, {
  knownLabels: new Set(["#roadmap", "@team"]),
});

// Completion overlay: injects a ghost or caret anchor before the highlighter runs.
preview.innerHTML = highlight.overlay(markdownText, highlight.markdown, {
  ghost: { at: cursorOffset, text: "uggestion" },
});

// Domain-specific languages: compile once, reuse on every input event.
const renderFormula = highlight.compile([
  { kind: "comment", match: /#.*/ },
  { kind: "string", match: /"(?:\\.|[^"])*"/ },
  { kind: "variable", match: /\$[a-zA-Z_]\w*/ },
  { kind: "keyword", match: /\b(IF|THEN|ELSE|SUM)\b/ },
  { kind: "number", match: /\b\d+(?:\.\d+)?\b/ },
  { kind: "operator", match: /[+\-*/=<>!]+/ },
]);

// Shallow presets for common snippets.
highlight.presets.sql(`SELECT id FROM users WHERE email = $1`);
```

### Dashboard with Inline SVG Charts

```typescript
import { charts } from "@k2b/stdlib";

// Bar chart with title, value labels, target reference, formatted axis
const revenue = charts.bar({
  title: "Quarterly Revenue",
  data: [
    { label: "Q1", value: 124 }, { label: "Q2", value: 187 },
    { label: "Q3", value: 162 }, { label: "Q4", value: 215 },
  ],
  yAxis: { format: v => `€${v}k` },
  references: [{ value: 200, label: "Target" }],
  showValues: true,
});

// Inline sparkline for a metric-row trend indicator
const trend = charts.sparkline({
  data: weeklyVisitors,
  smooth: true, area: true, showMinMax: true, showLast: true,
});

// Dashboard panels for monitoring-style UIs
const cpu = charts.gauge({ value: 72, min: 0, max: 100, label: "CPU", unit: "%" });
const signup = charts.funnel({ stages: [{ label: "Visitors", value: 100 }, { label: "Signed up", value: 40 }] });
const health = charts.stateTimeline({
  rows: [{ label: "API", intervals: [{ from: 0, to: 8, state: "ok" }] }],
  states: [{ state: "ok", label: "OK" }],
});
const regions = charts.map({
  series: [{
    label: "Healthy",
    data: [{ latitude: 52.52, longitude: 13.405, label: "Berlin" }],
  }],
  viewport: { latitude: 52.52, longitude: 13.405, zoom: 2 },
  legend: true,
});

// Scientific scatter with error bars and linear-regression overlay
const correlation = charts.scatter({
  series: [{ data: trials.map(t => ({ x: t.id, y: t.mean, errY: t.sd })) }],
  trendline: true,
  yAxis: { label: "Reaction (ms ± σ)" },
});

// All functions return SVG strings — inject via innerHTML or write to disk
document.getElementById("revenue").innerHTML = revenue;
```

### Reactive Cross-Tab Storage

```typescript
import { kvStore } from "@k2b/stdlib/browser";

// Persistent OPFS-backed key-value storage (async, no 5 MB cap, cross-tab via BroadcastChannel)
await kvStore.set("user:1", { name: "Alice", lastSeen: Date.now() });
await kvStore.setBytes("files:photo.raw", largeUint8Array);

// React to changes — fires for local writes AND writes from other tabs
const unwatch = kvStore.watch(
  (event) => {                   // event = { type: "set" | "delete" | "clear", key }
    if (event.type === "set") refreshUI(event.key);
  },
  "user:",                       // optional prefix filter
);

// Later: stop watching (e.g. component unmount)
unwatch();
```

### Interactive SolidJS Editor

```typescript
import { mutation, query, timed, hotkeys } from "@k2b/stdlib/solid";
import { notifications } from "@k2b/stdlib/browser";

const documentQuery = query.create({
  source: () => documentId(),
  initial: { source: props.documentId, data: props.document },
  load: (id, { abortSignal }) => api.loadDocument(id, abortSignal),
});

const save = mutation.create({
  // Autosave: the newest document must win over a save that is still running.
  concurrency: "replace",
  mutation: (doc) => api.saveDocument(doc),
  onSuccess: () => notifications.show({ title: "Saved", body: "Document saved.", autoCloseMs: 3000 }),
});

const autoSave = timed.debounce(() => save.mutate(currentDoc()), 2000);

hotkeys.create({
  "mod+s": { label: "Save", run: () => save.mutate(currentDoc()) },
  "mod+shift+s": { label: "Save & Close", run: () => { save.mutate(currentDoc()); navigate("/"); } },
});
```

*These examples combine a few of the 30+ modules available across four entry points -- see the [full documentation](./docs/) for the complete API.*

## Documentation

```
docs/core.md      -- encoding, crypto, password, dates, i18n, money, text, fuzzy, highlight, charts, cache, result, svg, streaming, ...
docs/browser.md   -- files, images, cookies, clipboard, notifications, kv-store, theme
docs/solid.md     -- mutation, query, hotkeys, dnd, timed, localstorage, ...

# qr lives behind its own subpath because lean-qr is an optional peer dep
import { qr } from "@k2b/stdlib/qr";
```

## Development

`@k2b/stdlib` is developed in `packages/stdlib` of the
[Cloud repository](https://github.com/k2b-dev/cloud) and released from there
with tags `npm-stdlib-vX.Y.Z`. It stays a standalone package without Cloud
dependencies. From the repository root:

```bash
bun run test --filter packages/stdlib
bun run --cwd packages/stdlib typecheck
bun run --cwd packages/stdlib bench:dates
```

## Agent Skills

An agent skill for `@k2b/stdlib` lives in `skills/stdlib` of the Cloud repository:

```bash
bunx skills add k2b-dev/cloud --skill stdlib
```

## License

ISC

Finance generators have a documented [validation and conformance contract](./docs/finance-conformance.md),
including independent CI checks and the Grids migration boundary.
