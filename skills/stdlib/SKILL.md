---
name: stdlib
description: >
  Use this skill whenever code imports from @k2b/stdlib,
  @k2b/stdlib/browser, @k2b/stdlib/solid, or
  @k2b/stdlib/qr, and whenever the user needs help choosing,
  using, documenting, testing, or updating stdlib utilities. Trigger broadly
  for encoding, hashing, encryption, UUIDs, ULIDs, readable IDs, TOTP,
  passwords, dates, calendars, public holidays, recurring events, i18n message
  catalogs, locale resolution, Accept-Language parsing, timing, streaming,
  DATEV CSV, DATEV XML Belegtransfer packages, SEPA XML, camt.052 imports, E-Invoices, money, taxes, allocation, Result errors, caching,
  search params, text formatting, fuzzy matching, syntax highlighting,
  charts, QR codes, file icons, gradients, SVG avatars, browser file
  downloads, ZIP archives, file pickers, OPFS, image processing, cookies,
  clipboard, notifications, browser kvStore, theme toggling, SolidJS
  mutations, owner-local and infinite queries, hotkeys, drag-and-drop, localStorage sync, click-outside,
  dropzones, accessibility helpers, or stdlib release/doc/skill updates.
---

# @k2b/stdlib

DATEV CSV `documentGuid` (Beleglink) and XML `kind: "documentImage"` require
`@k2b/stdlib >= 0.36.0`. Read `references/finance.md` and `references/datev-xml.md`
for the paired image-transfer/monthly-booking workflow.

Expanded `ServiceError` HTTP error statuses (including 413, 422, 429, 502,
503 and 504) and `err.tooManyRequests()`/`err.unavailable()` require
`@k2b/stdlib >= 0.35.0`. The existing numeric shape check in `isServiceError()`
and error pass-through in `tryCatch()` are unchanged.

Solid mutation `status()`, `settledAt()`, `concurrency`, `cancel()` in `onBefore`, and
`run.retry()` in `onError` require `@k2b/stdlib >= 0.34.0`; since then a second
`mutate()` while one runs is dropped unless `concurrency: "replace"` is set, and
`mutate()` resolves with the call's outcome (`"success" | "error" | "aborted" | "dropped" | "superseded"`).

Explicit E-Invoice payment rounding (BT-114) requires `@k2b/stdlib >= 0.31.0`.

`err.conflict(message)` taking its full sentence as given (it no longer appends
" already exists") requires `@k2b/stdlib >= 0.33.0`.
DATEV XML Belegtransfer packages (`datevXml`, `createDatevXmlPackage`) require
`@k2b/stdlib >= 0.30.0`.
German public holidays (`publicHolidays`) and tree-shakeable root imports require
`@k2b/stdlib >= 0.29.0`.
Solid query, mutation, and clipboard reader-error isolation requires
`@k2b/stdlib >= 0.28.0`.
Optional E-Invoice payment/period APIs and locale-ordered absolute dates require
`@k2b/stdlib >= 0.27.0`.
E-Invoice VAT categories and exemption reasons require `@k2b/stdlib >= 0.26.0`.
Finance header APIs and strengthened format validation require
`@k2b/stdlib >= 0.25.0`; CAMT and E-Invoice APIs require `>= 0.24.0`.
Check the consumer's installed version before using them.

This is the single entry skill for all `@k2b/stdlib` work. Keep this
file as the router and load detailed references only when the task needs them.

## Start Here

1. Identify the import path or runtime from the user's request.
2. Read the matching reference file before changing code or giving API-specific
   advice.
3. Prefer the existing namespace-object API style (`crypto.common.ulid()`,
   `charts.sparkline()`, `files.downloadFileFromContent()`,
   `mutation.create()`, `query.create()`).
4. For repo changes, verify with the narrowest relevant tests first, then run
   broader checks only when the change touches shared behavior.

## Entry Points

| Import path | Runtime | Read when |
|---|---|---|
| `@k2b/stdlib` | Universal browser/server | Core utilities, money, charts, highlighting, QR payload helpers, crypto, dates, i18n, text, result, cache |
| `@k2b/stdlib/finance` | Universal, optional peers, pure JS | DATEV CSV/XML and SEPA generation, camt.052 reading, and E-Invoices |
| `@k2b/stdlib/finance/validate` | Universal with optional WASM peer | Optional SEPA/CAMT/E-Invoice/DATEV XML XSD validation; `createDatevXmlPackage` |
| `@k2b/stdlib/qr` | Universal with optional `lean-qr` peer | QR payload generation or SVG rendering |
| `@k2b/stdlib/browser` | Browser DOM APIs | Downloads, ZIP, file pickers, OPFS, image processing, cookies, clipboard, notifications, kvStore, theme |
| `@k2b/stdlib/bun` | Bun | `loadDatevXmlSchemas(dir)` for DATEV XML validation |
| `@k2b/stdlib/solid` | SolidJS; reactive owner where noted | Mutations, owner-local queries, timers, hotkeys, drag-and-drop, localStore, detailPanel, clipboard, clickOutside, dropzone, a11y |

## Reference Routing

Load exactly the files needed for the task:

| Need | Reference |
|---|---|
| Complete root API: encoding, crypto, password, dates, i18n, money, timing, streaming, text, fuzzy, highlight, charts, cache, result, QR, SVG, searchParams, fileIcons, gradients | `references/core.md` |
| E-Invoice XML generation and XML/PDF reading | `references/einvoice.md` |
| camt.052 account report reading | `references/camt.md` |
| DATEV/SEPA header validation, serialization, exact amounts, independent conformance, Grids extraction | `references/finance.md` |
| DATEV XML-Schnittstelle online (Belegtransfer ZIP): invoices, cash, document images, XSD check | `references/datev-xml.md` |
| Browser API: files, images, cookies, clipboard, notifications, kvStore, theme | `references/browser.md` |
| SolidJS API: mutation, query, timed, hotkeys, dnd, detailPanel, localStore, clipboard, clickOutside, dropzone, a11y | `references/solid.md` |
| Crypto/security usage decisions, ULID caveats, symmetric/asymmetric/TOTP guidance | `references/core-crypto-guide.md` |
| Cross-module core recipes | `references/core-patterns.md` |
| Browser image pipeline details | `references/browser-images-guide.md` |
| Browser kvStore architecture and patterns | `references/browser-kvstore-guide.md` |
| SolidJS lifecycle and integration patterns | `references/solid-patterns.md` |
| Upgrade/migration checks for consumer codebases | `references/migrate.md` |
| Common task recipes across stdlib modules | `references/recipes.md` |

For broad module-selection questions, this file may be enough. For concrete API
usage, read the matching detailed reference first.

## Module Picker

### Core

| User needs | Module |
|---|---|
| Base64, Hex, Base32, Base62 | `encoding` |
| SHA-256, FNV-1a, UUID, ULID, readable IDs, keys | `crypto.common` |
| ECDSA/ECDH key pairs, signing, asymmetric encryption | `crypto.asymmetric` |
| AES-256-GCM encryption, password/key based encryption | `crypto.symmetric` |
| TOTP setup and verification | `crypto.totp` |
| Random, memorable, or PIN passwords; strength checks | `password` |
| Timezones, relative time, durations, recurring-event formatting, calendar grids, date ranges, German public holidays by state | `dates` |
| Type-safe message catalogs, locale fallback resolution, Accept-Language parsing, plural forms, list formatting, collation | `i18n` |
| Sleep, jitter, shuffle, buffer, debounce, throttle | `timing` |
| SSE or NDJSON stream parsing | `streaming` |
| Slugs, casing, humanize, truncate, number/percent/currency/millisecond-duration/byte formatting | `text` |
| Fuzzy match/filter/segments/closest typo correction | `fuzzy` |
| Headless markdown/editor/custom syntax highlighting | `highlight` |
| Scatter, line, bar, pie, donut, histogram, boxplot, sparkline, gauge, bar gauge, stat, heatmap, world map with deterministic viewports, state timeline SVGs | `charts` |
| In-memory TTL cache with optional lazy `onMiss` | `cache` |
| Exact money, tax, CSV amounts, credits and allocation | `money` |
| Typed success/error service results | `result`, `ok`, `fail`, `err`, `unwrap`, `tryCatch` |
| QR payloads and QR SVG rendering | `qr` from `@k2b/stdlib/qr` |
| Avatar SVGs and WebP data URL parsing | `svg` |
| URL search param serialization/deserialization/change listeners | `searchParams` |
| File icon/category lookup | `fileIcons` |
| CSS gradient presets | `gradients` |

### Browser

| User needs | Module |
|---|---|
| Download files, build ZIPs, open file/folder dialogs, MIME checks, OPFS files | `files` |
| Resize, crop, filter, rotate, flip, export, and batch-process images | `images` |
| Read/write string or JSON cookies | `cookies` |
| Copy text to the clipboard | `clipboard` |
| Native browser notification permission and display | `notifications` |
| OPFS-backed persistent key-value storage with cross-tab sync | `kvStore` |
| Light/dark mode state with cookie persistence | `theme` |

### Solid

| User needs | Module |
|---|---|
| Async mutation controller with loading/error/abort/retry | `mutation` |
| Owner-local reads with source changes, refresh, invalidation, last-good data, or infinite pagination | `query` |
| Lifecycle-aware debounce and interval timers | `timed` |
| Global keyboard shortcut registry | `hotkeys` |
| Pointer and keyboard drag-and-drop | `dnd` |
| URL-synced detail panel with browser history | `detailPanel` |
| Reactive localStorage with cross-tab sync | `localStore` |
| Reactive clipboard copy feedback | `clipboard` |
| Click-outside detection | `clickOutside` |
| File drop zone with MIME validation | `dropzone` |
| Accessible click-or-enter handlers | `a11y` |

## Repo Workflow

- Read source before changing docs or skill references. The references should
  describe the current code, not desired behavior.
- Keep package docs, examples, and this skill in sync when adding or changing
  public APIs.
- Keep browser-only and SolidJS-only utilities on their subpath entry points.
- Package modules (root and every subpath) must not rely on import-time
  effects that other modules or consumers need, because the package declares
  `"sideEffects": false` and bundlers drop modules nobody imports a binding
  from. `dates.ts` extends the shared dayjs with utc and timezone only for its
  own helpers; consumers that call dayjs directly register those plugins
  themselves. `src/bundle.test.ts` guards that an i18n-only root import stays
  free of dayjs and big.js.
- Avoid introducing external dependencies unless the module already depends on
  them or the user explicitly accepts the tradeoff.
- Preserve headless utilities: core SVG/highlight/chart helpers should not
  inject CSS or themes unless the API explicitly accepts style options.

## Validation

Choose verification proportional to the change:

| Change | Check |
|---|---|
| Skill/reference-only update | Validate the skill folder and grep for stale skill names/paths |
| Core API change | Targeted `bun test` for the module, then package typecheck |
| Browser utility change | Browser/runtime tests where available plus typecheck |
| Solid primitive change | Solid-specific tests plus typecheck |
| Public API or release prep | Docs/README/examples/skills updated, `git diff --check`, package tests/typecheck |

For this skill itself, the expected installed shape is one discoverable
`stdlib` skill with detailed files under `references/`; do not reintroduce
separate `stdlib-core`, `stdlib-browser`, or `stdlib-solid` skills.
