# Finance serialization

Since 0.36.0, optional `DatevPosting.documentGuid` fills EXTF column 20:
cell value `BEDI "<GUID>"`, raw CSV `"BEDI ""<GUID>"""`. Pass the bare document
GUID from Belegtransfer (36 characters, hex 8-4-4-4-12, no braces); preserve the
same spelling in both files. Both cases are accepted without conversion;
omission keeps the old bytes, empty/invalid input fails at the row field path.
[Official DATEV field 20](https://developer.datev.de/de/file-formats/details/datev-format/format-description/booking-batch)
explicitly specifies the cell format and doubled quotes. GUID case-insensitive
lookup in CSV is not explicitly guaranteed, so do not assume it. See
`references/datev-xml.md` for `kind: "documentImage"` and `docs/finance.md`.
**Release verification note:** Ein Testimport in DATEV ist hier nicht möglich; die Kanzlei muss einmal Testimport plus Beleglink prüfen.

Header APIs and strengthened format validation require `@k2b/stdlib >= 0.25.0`.

For camt.052 account report reading, see `camt.md`.

Import `{ datev, sepa }` from `@k2b/stdlib/finance`. This subpath requires optional
peers `zod@^4.4.3`, `ibantools@^4.5.4` and `saxes@^6.0.0`. Serialization is synchronous pure JS.
The separate `@k2b/stdlib/finance/validate` subpath exports `validateSepaXml` and
`sepaSchemaSha256`; only this checker requires `libxml2-wasm@0.6.0`.
Never re-export the checker from finance or finance from the root.

- `datev.validateHeader(unknown)` / `sepa.validateHeader(unknown)` return
  `Result<DatevHeader>` / `Result<SepaHeader>` for configuration only. Headers
  exclude `rows`, `createdAt`, and SEPA message/payment-information IDs.
  Shared rules are reused by full batch validation; do not invent dummy rows or IDs.
- `datev.validate(unknown)` / `sepa.validate(unknown)` return validated batches in
  stdlib `Result`; no coercion or Zod objects cross the runtime boundary.
- `datev.serialize(DatevBatch)` returns `Result<DatevFile>` with `bytes`,
  `rowCount`, `debitTotal`, `creditTotal`.
- `sepa.serialize(SepaBatch)` returns `Result<SepaFile>` with `bytes`,
  `rowCount`, `total`. Input checks run, but no XSD validation is claimed.
- `validateSepaXml(string)` checks arbitrary XML against the pinned XSD only;
  it does not check semantic control sums or application duplicate policy.
- Errors have `BAD_INPUT`/`INTERNAL`, status, message, and `issues`. Issue codes:
  `invalid_input`, `invalid_xml`, `schema_mismatch`, `schema_integrity`,
  `validator_unavailable`; `path` uses zero-based row indices. XML errors use
  `["xml"]` plus one-based `line`/`column` when available.

Required format literals: `datev-700-13` and
`sepa-sct-pain.001.001.09-gbic-5`. Both require `currency: "EUR"` and a caller
`createdAt` UTC string with exactly three fraction digits. SEPA message,
payment-information and end-to-end IDs are caller supplied; end-to-end IDs must
be unique within a file. Output preserves row order and is deterministic.

Amounts must be positive strings with exactly two decimal digits, no leading
zeros, exponents, or rounding. DATEV max `9999999999.99`; SEPA max `999999999.99`.
DATEV uses direction `S`/`H`, including credits. Totals remain exact decimal
strings; do not convert them to floating-point numbers.

DATEV supports consultant/client numbers, fiscal year and posting period,
account length, label, explicit finalize, and postings with accounts, document
date/number, optional text, tax key and cost centers. UTF-8 BOM, 31 header fields,
125 columns, CRLF. Optional `applicationInformation` (up to 16 characters) is
empty by default; use `"Grids"` to preserve the extracted renderer's bytes.

SEPA supports ordinary EUR SCT, one debtor/execution date/payment block, multiple
transfers, unstructured remittance, optional BICs; no instant payments, addresses
or direct debits. Names/remittance use the DK Latin repertoire plus `ÄÖÜäöüß&*$%`, are
nonblank, and are escaped without transliteration. Double quotes, angle brackets,
other accented letters, and emoji fail with input paths. IBANs
must be canonical uppercase, valid SEPA IBANs, not QR-IBANs.

The pinned schema hash is
`35cfe972a636392704fd930c3e0496fc05b95ff891deb635b168dcdabf3c08a3`.
No filesystem or external schema/entity resolution. Bun, Chromium and browser
workers are verified. Only optional-validator Bun browser bundling needs `external: ["module"]` for the
validator's conditional Node branch; use `splitting: true` to retain lazy chunks.
Web Crypto and WebAssembly are required for schema validation.

Applications retain mapping, authorization, confirmation, storage, audit,
business identities, durable duplicate claims, size limits, and payment status.
A generated file is neither bank submission nor payment or guaranteed acceptance.
No bank data, account codes or tax keys are inferred.

Repository references: `docs/finance.md`, `examples/finance.ts`, and
`docs/finance-grids-integration.md`. The latter is a proposal; Cloud was not
modified by this extraction.

For CII E-Invoice XML generation and XML/PDF reading, see `einvoice.md`.

Run `bun run test:finance-conformance` for independent official Schematron,
Python decimal/profile checks and the DATEV golden. Requires Java 11+ and Python 3;
first run downloads hash-pinned development artifacts. See `docs/finance-conformance.md`.
