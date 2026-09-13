# Grids document membership and observability

## Scope

One immutable document may belong to multiple records. Store membership from
frozen data at issuance, reuse it for Base record panels and GQL, and show a
bounded source inspector. No automatic propagation along relations. Preserve
existing workflow source-version checks and financial duplicate claims.

## Implemented behavior

- Added immutable indexed `document_record_sources` and completeness marker.
- Template issuance records its snapshot root; simple stored-table row captures
  record their unique public origins and versions. Document/snapshot inputs
  inherit exact sources, rejecting ambiguous versions as unknown membership.
- `associatedData` names another frozen row query for explicit membership of
  aggregate/join/value outputs. It is separate from freshness `sourceVersions`.
- Base record browsing includes associations. App template-scoped reads remain
  direct-only; membership does not grant a whole batch download.
- Public source count, sources endpoint/CLI, and source inspector added.
- `documentCount(format?)` and `latestDocumentAt(format?)` SELECT/WHERE SQL
  implemented. Stored field formulas reject them. Custom App query resolver
  rejects metadata, including nested plan expressions.

- Association references are checked against their canonical captures, included
  in the issuance hash, and protected by a same-run foreign key. A second capture
  is not a claim that its amounts equal those in the rendered data.
- Evidence exports include source membership and both frozen captures.
- Sources API documents bounded pagination and requires complete Document access.
  The dialog uses authorized presentable labels, captured versions, deleted
  states, retry, pagination, and new-tab record navigation.
- GQL preview and saved-table display projections share SQL semantics. Combined
  tables reject metadata functions. No new stored Formula function is added.
- Updated DE/EN Document, Workflow, and GQL Help; CLI reference and example;
  generated Assistant GQL reference; canonical application documentation.

## Verification

- Focused API, binder, source extraction, and GQL tests: 84 passed.
- GQL suite: 287 passed. Its 57 database-only cases were skipped in this unit
  invocation; focused database tests ran separately on isolated databases.
- Issuance, financial exports, and browsing: 30 passed in the first database
  regression run. Subsequent evidence/financial/browse regression: 26 passed.
- Added database coverage for explicit frozen selection, edits after capture,
  idempotent replay, source/output count distinction, inheritance, cross-base
  isolation, source retention, and saved-table computed metadata.
- Existing Document dialog behavior: 5 passed in browser-condition DOM tests;
  new source inspector behavior: 1 passed. Document rendering: 5 passed.
- Service/API contract and localization checks passed. Biome checks passed.
- Final Grids TypeScript check passed. The final financial regression passed
  12 tests, including inherited membership and source-capture retention.
- No development service restart, production deployment, or commit performed.

## Boundaries

Document metadata is live, even on finalized records. It is not a payment
confirmation and is not a replacement for atomic export claims. Base access
authorizes complete documents; a Custom App row grant does not.

Existing unrelated Assistant/UI changes and preceding Grids alpha-cut changes
remain preserved. No claim of a complete production or real-browser audit is
made by these focused checks.
