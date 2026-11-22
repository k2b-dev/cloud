# Proposed Grids integration

Replace only the format layer with `@k2b/stdlib/finance`. Keep Grids' existing
query issuance, preview, confirmation, reservation, and audit flow. This document
is a proposal; the Cloud checkout has not been changed.

## Why a stdlib subpath

The extraction contains two fixed formats, validation, and byte generation. It
has no persistence or service lifecycle. A separate package would add an
independent version, release, and dependency boundary without a current need for
one. The `/finance` subpath follows stdlib's existing optional-peer pattern and
keeps XML off ordinary imports. Zod and ibantools remain reusable validators;
exact totals use stdlib's existing big.js dependency. No format grammar or IBAN
validator is reimplemented.

A separate package becomes useful if these formats acquire independent release
cadence or substantially different maintenance ownership. That is not necessary
for the current two-format scope.

## Ownership after migration

| Extracted format layer | Remains in Grids |
|---|---|
| Supported fields, canonical amounts, dates, account lengths, IBAN/BIC checks | Queries, alias-to-field mapping, permissions, transport/UI schemas |
| Per-file end-to-end ID uniqueness | `businessId`, `entryId`, `destinationKey`, durable duplicate claims |
| CSV columns, escaping, totals, XML structure, local XSD | Filename policy, artifact storage, confirmation, audit, payment status |
| Explicit `createdAt` and format identifiers | Capturing/persisting timestamps and message/payment IDs |
| Structured input paths and XML diagnostics | Localization, UI warnings, business counts, input-size limits |

Keep the 10,000-row and 5 MiB budgets in Grids. Do not move
`canonicalDocumentJson`, document hashes, financial intent hashes, claim keys, or
issuance context into stdlib. Keep `sepaPreviewWarnings` in Grids: its date check
needs an application-supplied day, and bank-specific submission policy belongs to the application. Unsupported
DK characters are now hard input errors, not merely preview warnings.

## Concrete adapter steps

1. In `packages/grids/src/service/document-financial-output.ts`, retain field
   mapping and canonical input capture. After validating the application fields,
   call `datev.validate` or `sepa.validate` on a projection containing only format
   fields. Continue computing hashes over the full captured application input,
   including business identities; do not silently change persisted hash meaning.
2. In `document-profiles/datev-csv-contracts.ts` and
   `sepa-xml-contracts.ts`, keep Grids' transport shapes and application checks.
   Delegate format refinements to the new validators and map their issue paths
   into Zod issues. Do not maintain a second set of amount, date, IBAN, or format
   rules. call `datev.validateHeader` / `sepa.validateHeader` for configuration.
   These public validators exclude rows, timestamps, and SEPA generation IDs.
   Supply those only when a batch is assembled.
3. In `document-profiles/financial.ts`, retain the profile IDs, filename schemas,
   artifact metadata, and issuance context. Replace the renderer calls using the
   projections below. Map `FinanceResult` failures to the existing failure path;
   never store partial bytes or mark an unsuccessful result valid. For SEPA,
   explicitly call the optional XSD checker before storage to preserve the
   existing mandatory schema-validation behavior.
4. Retain business counts and the existing `imported: false` / `submitted: false`
   reports. Keep confirmation/claim handling in the service before serialization.
5. Once the dependency version is released and explicitly approved for Cloud,
   remove the old serializers and their XSD copy. Remove a dependency only after
   checking other Grids callers; `decimal.js` is still used by normalization and
   other services.

Adapter sketch for an already validated and authorized Grids DATEV batch:

```ts
import { datev } from "@k2b/stdlib/finance";

const { destinationKey, rows, ...header } = gridsBatch;
const result = datev.serialize({
  ...header,
  format: "datev-700-13",
  currency: "EUR",
  createdAt: context.issuedAt.toISOString(),
  applicationInformation: "Grids",
  rows: rows.map(({ businessId, entryId, ...posting }) => posting),
});
const businessCount = new Set(rows.map(row => row.businessId)).size;
// destinationKey, businessId and entryId remain in capture/claims, not in the CSV.
```

Equivalent SEPA projection:

```ts
import { sepa } from "@k2b/stdlib/finance";
import { validateSepaXml, sepaSchemaSha256 } from "@k2b/stdlib/finance/validate";

const { destinationKey, rows, ...header } = gridsBatch;
const result = sepa.serialize({
  ...header, // includes persisted messageId and paymentInformationId
  format: "sepa-sct-pain.001.001.09-gbic-5",
  currency: "EUR",
  createdAt: context.issuedAt.toISOString(),
  rows: rows.map(({ businessId, ...transfer }) => transfer),
});
if (!result.ok) throw new Error(JSON.stringify(result.error));
const validation = await validateSepaXml(new TextDecoder().decode(result.data.bytes));
if (!validation.ok) throw new Error(JSON.stringify(validation.error));
// Persist result.data.bytes only after success.
// Use sepaSchemaSha256 for existing schema-version metadata.

```

The outer profile still removes `filename` before constructing either projection.
Current format inputs use `rows`, so error paths can map back to captured rows
without renumbering. Header errors use their field name; XML-only failures use
`["xml"]` and optional source locations.

## Compatibility and migration checks

The extraction has golden tests against both existing Cloud serializers using
multiple postings/transfers and escaped text. Bytes match exactly when DATEV's
`applicationInformation` is `"Grids"` and the same timestamps/IDs are supplied.
Its default is empty, so pass that field explicitly to preserve existing output.

There are intentional contract changes: Grids-only fields are rejected, versions
and currency are explicit, timestamps are canonical UTC strings, application
limits are removed, and errors are structured Results. SEPA input validation also
reports invalid XML characters at their field instead of failing later during
escaping. Document the new renderer/validator versions before issuing new files;
retain historical metadata and artifacts unchanged.

For the actual Cloud migration, run the existing document-profile tests plus
`document-issuance.integration.test.ts`,
`document-financial-issuance.integration.test.ts`, and
`document-export-claims.integration.test.ts`. Verify preview/capture agreement,
permissions, confirmation requirements, duplicate protection, stored reports,
and byte parity. Those integration tests have not been rerun for this proposal;
only the existing isolated DATEV/SEPA tests and the stdlib extraction were checked.

For E-Invoice replacement, input changes and runtime validation decisions, see
[finance conformance and migration](./finance-conformance.md).
