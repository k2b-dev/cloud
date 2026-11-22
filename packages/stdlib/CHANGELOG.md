# Changelog

## 0.36.0 — 2026-11-19

- Add optional `DatevPosting.documentGuid`: EXTF 700/13 column 20 (Beleglink)
  links to a Belegtransfer document as `BEDI "<GUID>"`, with doubled inner quotes
  in CSV. Omission preserves the existing empty column and all other bytes.
  GUIDs use 36 hexadecimal characters/hyphens (8-4-4-4-12), without braces;
  uppercase/lowercase is accepted and preserved, matching DATEV's document XSD.
- Add `datevXml` kind `documentImage` with required `guid` and nonempty `files`.
  It writes only File extensions in `document.xml` and the attached files,
  without ledger extensions or generated ledger XML. `createDatevXmlPackage`
  checks these packages against the same pinned official XSDs. Existing ledger
  documents and their ZIP bytes are unchanged.
- **Type migration:** `DatevXmlDocument` includes `documentImage`;
  `DatevXmlFileDocument` includes file-only metadata without `dataFile`, `xml`
  or `amount`. Check `document.dataFile !== undefined` before using ledger
  metadata. File-only documents contribute zero to `lineCount`.
- DATEV import remains unverified: the expected filing under "Sonstige Belege"
  must be confirmed with the accounting firm, including that images produce no
  additional inbox booking proposal. Release verification note:
  Ein Testimport in DATEV ist hier nicht möglich; die Kanzlei muss einmal Testimport plus Beleglink prüfen.

## 0.35.0 — 2026-11-19

- Expand `ServiceError.status` to the HTTP error statuses used by consumers,
  including 413, 422, 429, 502, 503 and 504. Custom domain codes such as
  `READ_UNAVAILABLE` now work with `fail()` and status 503 without casts (#31).
- Add `err.unavailable(why?)` for `UNAVAILABLE`/503 (default message:
  "Service unavailable") and `err.tooManyRequests(why?)` for
  `TOO_MANY_REQUESTS`/429 ("Too many requests").
- Preserve the existing numeric shape check in `isServiceError()` and
  error pass-through in `tryCatch()`, including consumer-defined statuses
  outside the static type, such as 499. This release adds no runtime status
  restriction. Consumers with exhaustive status/code mappings may need to
  handle the new union members.

## 0.34.1 — 2026-11-18

- Date displays reuse a bounded set of Intl formatters by locale, timezone and
  format. `formatDateTime()` formats its existing 24-hour clock directly from
  the instant, avoiding a Dayjs timezone conversion and localized-string parse
  for every row. The date retains its locale and calendar; the clock reads
  the requested timezone directly, including at DST boundaries, without a
  host-local parsing roundtrip. Calendar arithmetic is unchanged.

## 0.34.0 — 2026-11-16

- Solid `mutation.create()` exposes `status()` (`idle`, `pending` while `onBefore`
  runs, `loading`, `success`, `error`, `aborted`) and `settledAt()`, the time of the
  last end. `settledAt()` is strictly increasing, so it changes on every end, also
  for two equal errors in a row; the new `now` option sets the clock. Several
  buttons, menu items, or hotkeys bound to one mutation can show the same state.
- **Behaviour change:** a `mutate()`, `retry()`, or `run.retry()` while another call
  is `pending` or `loading` is dropped by default (`concurrency: "drop"`): it runs
  nothing, changes no state, runs no hook, and resolves `"dropped"`. This also guards
  hotkeys, form submits, and code. **Migration:** give mutations where the newest call
  must win (autosave, search as you type, drag reorder, rapid toggles) `concurrency:
  "replace"`, which keeps the old superseding behaviour; give rows their own mutation;
  release local busy flags after the `await`, not only in `onFinally`.
- **Behaviour change:** `mutate()`, `retry()`, and `run.retry()` resolve with the
  call's outcome, `"success" | "error" | "aborted" | "dropped" | "superseded"`
  (`MutationOutcome`), instead of `undefined`. `dropped`: the call ran nothing;
  `superseded`: it ran but a newer call replaced it (`concurrency: "replace"`).
  **Migration:** after `await`, branch on the outcome instead of reading `error()` or
  `data()`, which may describe another call.
- **Behaviour change:** `abort()` ends the call in flight at once: `status()` becomes
  `aborted` synchronously and `onAbort`/`onFinally` run right away, also while the
  mutation function still runs (formerly they ran only when it returned); whatever
  the function returns later is discarded. A call still in `onBefore` ends the same
  way, its later `onBefore` result is ignored, and the hook's new `signal` fires.
  `abort(); mutate(next)` starts `next` at once.
  Abort hooks and signal listeners may start a new run without losing its state.
  Hook or reader errors during abort reject `mutate()`, and `onFinally` runs once.
- `retry()` resolves `"dropped"` when the last call never reached the mutation
  function (cancelled, aborted while pending, failed in `onBefore`); it never repeats
  an older call.
- `onBefore(vars, { cancel, signal })`: `signal` fires when `abort()` ends the call while
  the hook runs; check it after every `await`. `cancel()` ends the hook immediately; the call ends
  `aborted` without `onError` or `onAbort`, `onFinally` runs without a context,
  `mutate()` resolves `"aborted"`, and `retry()` does not repeat it. Ask first, then
  change optimistically.
- `onError(error, ctx, run)`: `run.retry()` repeats exactly the failed call, also
  after other calls ran. A call that failed in `onBefore` runs `onBefore` again.
  Wrappers that forward `onError` must pass the third argument.
- `loading()`, `error()`, and `status()` are now committed before `onError` and
  `onAbort` run, as they already were before `onSuccess`, so hooks may start the
  next call. A throw in `onSuccess` keeps `status()` at `success` and still
  rejects `mutate()`.
- With `concurrency: "replace"`, a newer call that fails or is cancelled in
  `onBefore` while an older run loads no longer writes an end in the middle of that
  run, and a success clears `error()`.

## 0.33.0 — 2026-11-16

- `err.conflict(message)` takes its full sentence as given and appends nothing.
  It used to append " already exists", which turned sentences such as
  "Task changed; read it and retry" into "Task changed; read it and retry
  already exists" (k2b-dev/cloud#1326).
- Migration: a call that passes only a noun keeps its meaning with the words
  written out, for example `err.conflict("Email")` becomes
  `err.conflict("Email already exists")`. Calls that already pass a sentence
  need no change. This message change requires a minor release under the 0.x
  convention.

## 0.32.2 — 2026-11-14

- Highlight presets keep their output while bounding delimiter scans: unfinished
  block comments in the code and SQL presets run through EOF, failed quoted-token
  scans are cached through EOF, and failed SQL bracket-identifier and shell
  `${...}` scans through the newline or EOF, so repeated openers never rescan the
  same suffix. Token class names are trimmed in linear time (#24).
- This restores the 0.32.0 output for unfinished quoted strings, SQL bracket
  identifiers and shell `${...}` variables; only unfinished block comments still
  highlight through EOF.

## 0.32.1 — 2026-11-14

- Highlight presets consume unfinished block comments and quoted strings through
  EOF instead of rescanning the rest of the input at each repeated opener; SQL
  bracket identifiers and shell `${...}` variables stop at a newline or EOF. Closed
  tokens keep their output. A 75,000-character input went from 2.3 s to under
  1 ms (#23).
- Output change: an unfinished quoted string is highlighted as a string through
  EOF, where 0.32.0 left the rest of the input plain.

## 0.32.0 — 2026-11-09

- Accept omitted or empty seller/buyer address line 1 (BT-35/BT-50), omit empty
  CII `LineOne`, and accept its absence in strict XML/PDF readers (#21).
- Type migration: `Invoice` and strict parsed output now expose `line1` as
  `string | undefined`. Check presence or use `line1 ?? ""` for display.
  This reader type widening requires a minor release under the 0.x convention.
- Keep country, city, postcode and supplied-text checks unchanged. Existing
  nonempty address lines produce byte-identical XML. Add Schematron 1.3.16,
  XSD, XML/PDF round-trip and legacy-byte regression coverage.

## 0.31.1 — 2026-11-08

- Let applications theme pointer drag previews through `--stdlib-dnd-ghost-shadow`,
  `--stdlib-dnd-badge-shadow`, and `--stdlib-dnd-badge-bg` without `!important` (#19).
  Existing shadows and badge background remain the defaults.

## 0.31.0 — 2026-10-22

- Add explicit BT-114 payment rounding through
  `einvoice.calculate(lines, { roundingAmount })`, `InvoiceCalculationOptions`,
  and `InvoiceTotals.roundingAmount` (#14). Validation, CII XML generation and
  strict parsing preserve the signed amount, including explicit zero.
- VAT and gross totals retain their net-based calculation; the amount due is
  gross plus rounding. For example, net 84.03 + VAT 15.97 = gross 100.00,
  with rounding -0.01 and amount due 99.99. Callers choose the adjustment;
  `money.taxFromGross` is unchanged. Omitting rounding preserves existing
  result shapes and XML bytes.
- Reject malformed rounding, negative amounts due, inconsistent declared
  totals and generated totals beyond the existing supported range.

## 0.30.0 — 2026-10-18

- Add DATEV XML-Schnittstelle online 6.0 packages for DATEV Belegtransfer:
  `datevXml.validate` and `datevXml.serialize` in `@k2b/stdlib/finance` build a
  ZIP with `document.xml`, one ledger file per document and the document images
  for incoming invoices (`accountsPayableLedger`), outgoing invoices
  (`accountsReceivableLedger`) and cash (`cashLedger`, Kassenbuch online).
  Serialization is synchronous, deterministic and needs no XSD engine.
- Add `createDatevXmlPackage(input, { schemas })` and
  `validateDatevXml(xml, { schema, schemas })` in `@k2b/stdlib/finance/validate`.
  `createDatevXmlPackage` checks `document.xml` and every ledger file against
  DATEV's XSDs (version 6.0) and returns bytes only when all pass. The XSDs are
  not shipped: callers supply them, `datevXmlSchemaSha256` pins each file and a
  missing or changed file returns `INTERNAL` (`validator_unavailable` /
  `schema_integrity`). `loadDatevXmlSchemas(dir)` in `@k2b/stdlib/bun` reads them.
- `validateInvoiceXml` returns `validator_unavailable` instead of rejecting when
  its reader cannot be loaded (for example without `saxes`).
- The publish workflow fails unless the tag equals the `package.json` version and
  the tagged commit is on `main`; it no longer rewrites the version from the tag.
- Invalid values fail with field paths and are never cut, replaced or converted:
  DATEV character set and NFC, field lengths (booking text 30), `0.00` amounts,
  mixed signs within an invoice, creditor and debtor account ranges, dates
  outside the period, duplicate GUIDs, file names, types and sizes (20 MB per
  file), and DATEV's package limits (4999 documents, 5000 lines, 465 MB).

## 0.29.0 — 2026-10-12

- Add German public holidays by federal state: `publicHolidays(year, region)`
  returns the statutory holidays of `"DE"` or `"DE-<state>"` as dates with stable
  keys (no translated names), including Easter-based dates and the years in which
  state holidays were introduced. Out-of-range years throw a `RangeError` (#8).
- Declare `"sideEffects": false`, so bundlers keep only the root exports you
  import. Importing `i18n` alone no longer pulls in dayjs and big.js (about 41 KB
  minified down to about 1.5 KB). If you use dayjs directly, register its `utc`
  and `timezone` plugins yourself (#9).

## 0.28.0 — 2026-10-08

- Keep errors thrown by components and computations that read Solid primitive
  signals out of the primitive's own state. `query.create`, `query.createInfinite`,
  `mutation.create`, `clipboard.create`, and `clipboard.createWriter` no longer
  store these errors in `error()`; they reach the nearest Solid error boundary or
  surface as unhandled errors.
- Commit query results in one batch after internal state settles. Loading flags
  stay consistent and `invalidate()` resolves when its snapshot was committed,
  even if a reader throws. A reader error while a load, `invalidate()`,
  `loadMore()`, or `abort()` starts no longer leaves a query looking busy without
  a running load.
- **Behavior change:** `mutate()` and `retry()` reject with errors thrown by
  `onSuccess` or by readers of the committed result. These errors no longer set
  `error()` or call `onError`. `onSuccess` runs after `data()` and `loading()`
  are updated. Handle `onSuccess` failures with `try/catch` around `mutate()` or
  an error boundary instead of `onError`.
- Clipboard `copy()` rejects with reader errors during copy feedback instead of
  reporting a failed copy, and `wasCopied()` always resets.

## 0.27.0 — 2026-09-29

- Make E-Invoice payment instructions optional. Support cash (10), credit
  transfer (30/58), online payment services (68), and clearing (97), with optional
  payment information. Existing payment objects default to 58 with unchanged XML.
- Add header invoicing periods and allow invoice/selfBilling references for
  additional charges. Add `selfBillingCreditNote` (261) for buyer-issued reductions;
  update exhaustive kind switches. Credit notes can omit payment instructions. Validate
  payment accounts, period dates, reference numbers/dates and K delivery data.
- **Type migration:** `Invoice.payment` and `serviceDate` are optional, including
  default XML/PDF parse results. Guard presence before access. Bank fields are
  optional in the type and checked by payment code; readers return explicit codes.
- **Output change:** Absolute dates use Intl locale order and punctuation for
  every locale. Default English becomes `Mar 5, 2025`; German becomes
  `5. März 2025`. This also affects `formatDateTime`, relative absolute fallbacks
  and recurrence until dates. UTC defaults and the 24-hour clock are unchanged.
- Add `formatDate(input, { style: "numeric" })` for padded numeric dates in locale
  order. `formatDateKey`, `formatDateShort`, and relative bucket logic stay unchanged.
- Add payment, period, and correction round trips, legacy XML byte regression,
  XSD checks, official CII Schematron cases, and migration examples.

## 0.26.0 — 2026-09-23

- Generate and read CII EN16931 invoices with VAT categories S, Z, E, AE, K, G,
  and O. Omitted categories still mean S; existing S XML output is unchanged.
- Group tax by category and numeric rate. Accept exemption text (BT-120) and
  VATEX codes (BT-121) on lines or declared groups, and return group reasons on
  parsed lines. Support mixed S+E invoices and E margin schemes with VATEX-EU-F,
  VATEX-EU-I, and VATEX-EU-J.
- Check category rates, zero disclosed tax, reasons, identities, group
  membership, and O exclusivity. Z forbids exemption reasons. O omits XML rates
  and VAT IDs while retaining `taxRate: "0"` and `vatId: ""` in the string API.
- Add optional party `id`, seller `taxRegistrationId`, and invoice
  `deliverToCountryCode` for the relevant identity and delivery requirements.
  AE/K require the buyer VAT ID; K also requires the actual delivery country.
- Add an example for §25a, category round trips, XSD checks, and official EN16931 CII
  Schematron regression cases. Runtime XML validation remains XSD-only.
- Add backward-compatible `mode: "incoming"` XML/PDF overloads with a separate
  `IncomingInvoice` model for independent EN16931 and CII XRechnung 3.0/2.3
  invoices. Preserve optional data, payment variants, currencies, price bases,
  periods, adjustments, declared totals, and explicitly unmapped XML fields.
- Run 11 unchanged, hash-pinned public invoices through extraction assertions,
  XSD and official EN16931 core Schematron in CI. Add malformed-input and
  ambiguity regressions; existing strict reader/generation APIs stay intact.
- Keep the compiled invoice XSD available after another libxml2 consumer resets
  global input providers; repeated and concurrent validation stays independent.
