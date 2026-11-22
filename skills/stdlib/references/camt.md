# camt.052 account reports

Use `camt.parse(xml, limits?)` from `@k2b/stdlib/finance`. It returns
`FinanceResult<CamtDocument>` synchronously, without DOM/WASM. The finance peers
are Zod 4, ibantools 4 and saxes 6. Root stdlib imports stay isolated.

Only the exact `urn:iso:std:iso:20022:tech:xsd:camt.052.001.08` Document namespace
is supported. Prefixes are resolved automatically; never configure a bank name.
Other versions/messages, ZIP and transport envelopes are not supported. The
application supplies a decoded XML string containing a standalone Document.

Result hierarchy is document -> reports -> entries -> detail groups ->
transactions. Entry amounts and batch/transaction details must not be added
together. Missing detail amounts/directions remain absent. Amounts are exact
unsigned decimal strings with their own currency; `CRDT`/`DBIT` and optional
reversal are separate. Preserve pending/proprietary status; do not infer payment
completion. No FX, rounding, reconciliation, inherited amounts, deduplication,
missing-page fetches or bank-data lookup is performed.

Typed fields include report accounts, balances, dates, pagination, entry status
and codes, transaction references, party/account data and remittance. Additional
fields and structured remittance are available in plain namespace-aware XML
element trees; the complete tree is `result.data.document`. Comments/PIs are
omitted; entities/CDATA become text. No byte-exact XML roundtrip is promised.

Input parsing is not full XSD validation. Import `validateCamtXml` and
`camtSchemaSha256` from `@k2b/stdlib/finance/validate` for the optional ISO .08 XSD
check, requiring `libxml2-wasm@0.6.0` and Web Crypto. No external schemas/entities
are loaded. DTDs fail before WASM; ordinary comments and CDATA are supported.
Optional-validator browser builds retain the same conditional Node `module`
external setting as SEPA; pure JS reading needs no such setting.

Both APIs default to limits of 10 Mi UTF-16 code units, 250,000 elements, depth
64. Options are `maxCharacters`, `maxElements`, `maxDepth` (positive safe integers).
XML paths use local names and zero-based occurrence indices with parser
line/column locations when available. Codes additionally include
`unsupported_format` and `input_limit`. Input errors have BAD_INPUT; unavailable
checker dependencies or schema hash mismatches have INTERNAL.

Read `docs/camt.md`, `src/finance/camt-types.ts`, and `examples/camt.ts` in the
repository for the public contract. The XSD is from ISO 20022; tests also use
public MNB documents. No actual Sparkasse export has been verified. The saxes
upstream is archived; preserve strict XML/namespace regression coverage when
updating or replacing it.
