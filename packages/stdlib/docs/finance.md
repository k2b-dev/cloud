# DATEV and SEPA serialization

`@k2b/stdlib/finance` validates typed inputs and generates DATEV booking CSV or
SEPA credit-transfer XML. It does not query data, map fields, store files, submit
payments, or track payment status. Generating a file is not a payment.

```sh
bun add @k2b/stdlib zod@^4.4.3 ibantools@^4.5.4 saxes@^6.0.0
# Optional, only for full XSD validation:
bun add libxml2-wasm@0.6.0
```

The finance subpath requires Zod, ibantools and saxes as optional peers. The root,
`/browser`, `/solid`, `/qr`, and `/bun` entry points do not import finance.
Both serializers and input validators run in pure JavaScript. They do not import
the XSD or WASM engine. Full XSD checking is an explicit, separate step through
`@k2b/stdlib/finance/validate`; only that subpath needs the WASM peer.

For reading bank account reports, see [camt.052 import](./camt.md). For DATEV
Belegtransfer packages with document images, see [DATEV XML](./datev-xml.md).

## Public contract

```ts
import { datev, sepa } from "@k2b/stdlib/finance";
import type {
  DatevHeader, DatevBatch, DatevPosting, DatevFile,
  SepaHeader, SepaBatch, SepaTransfer, SepaFile,
  FinanceResult, FinanceError, FinanceIssue,
} from "@k2b/stdlib/finance";

// Configuration checks need no rows, timestamps, or generated IDs.
datev.validateHeader(input: unknown): FinanceResult<DatevHeader>;
sepa.validateHeader(input: unknown): FinanceResult<SepaHeader>;

// Input validation also accepts untrusted JSON. It performs no coercion.
datev.validate(input: unknown): FinanceResult<DatevBatch>;
sepa.validate(input: unknown): FinanceResult<SepaBatch>;

// Both serializers revalidate inputs. Failed results contain no partial file.
datev.serialize(input: DatevBatch): FinanceResult<DatevFile>;
sepa.serialize(input: SepaBatch): FinanceResult<SepaFile>;

// Checks arbitrary XML against the pinned XSD, not all semantic batch rules.
import { validateSepaXml, sepaSchemaSha256 } from "@k2b/stdlib/finance/validate";
validateSepaXml(xml: string): Promise<FinanceResult<void>>;
sepaSchemaSha256: string;
```

The signatures above are reference notation. `validate` returns a validated copy;
`serialize` returns bytes and exact string totals. Inputs are not mutated. No
accounts, tax codes, IBANs, IDs, or current dates are generated.

`FinanceResult<T>` uses stdlib's `{ ok: true, data: T }` or
`{ ok: false, error: FinanceError }`. An error has `code` (`BAD_INPUT` or
`INTERNAL`), `status`, `message`, and an `issues` array:

```ts
const result = sepa.validate(untrustedJson);
if (!result.ok) {
  for (const issue of result.error.issues) {
    console.log(issue.code, issue.path, issue.message);
    // e.g. "invalid_input", ["rows", 1, "amount"], "..."
  }
}
```

Input paths contain field names and zero-based row indices. XML errors use
`["xml"]` with one-based `line` and `column` when available. Issue codes are
`unsupported_format`, `input_limit`, `invalid_input`, `invalid_xml`,
`schema_mismatch`, `schema_integrity`, and
`validator_unavailable`. Missing validator support or schema-integrity failures
are `INTERNAL`; invalid caller data is `BAD_INPUT`. Diagnostic messages are not
stable localization keys; use codes and paths for application UI.

Every batch requires a supported literal `format`, `currency: "EUR"`, and
`createdAt` as a UTC timestamp with exactly three fractional digits, for example
`"2026-09-11T12:34:56.789Z"`. The caller supplies and persists the timestamp and
payment IDs. SEPA dates and timestamps reject year zero (as required by XSD).
Identical inputs produce identical bytes in input row order.

Amounts are positive canonical decimal **strings with exactly two fraction
digits**. `"12.30"` is accepted; `12.3`, `"12.3"`, `"12.300"`, `"01.00"`,
`"1e2"`, `"-1.00"`, and `"0.00"` are rejected. Totals use exact decimal addition
and remain strings, even when their minor-unit value exceeds a safe JS integer.
There is no rounding, currency conversion, or number-to-decimal coercion.

## Generate a DATEV booking batch

```ts
import { datev } from "@k2b/stdlib/finance";

const result = datev.serialize({
  format: "datev-700-13",
  currency: "EUR",
  createdAt: "2026-09-11T12:34:56.789Z",
  applicationInformation: "InvoiceTool", // optional; empty when omitted
  consultantNumber: "29098",
  clientNumber: "55003",
  fiscalYearStart: "2026-01-01",
  accountLength: 4,
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  label: "September 2026",
  finalize: false,
  rows: [
    {
      amount: "123.45", direction: "S", account: "00440", counterAccount: "70000",
      documentDate: "2026-09-11", documentNumber: "RE-2026-1",
      text: 'Office; "rent"', taxKey: "0009",
    },
    {
      amount: "3.00", direction: "H", account: "00440", counterAccount: "70000",
      documentDate: "2026-09-12", documentNumber: "GS-2026-1", text: "Credit",
    },
  ],
});
if (!result.ok) throw new Error(JSON.stringify(result.error));
result.data.bytes;       // Uint8Array; save using an EXTF_*.csv filename
result.data.rowCount;    // 2
result.data.debitTotal;  // "123.45"
result.data.creditTotal; // "3.00"
```

The supported subset is DATEV 700/13, EUR booking batches: UTF-8 with BOM,
semicolon-separated fields, 31 header fields, 125 data columns, CRLF line endings,
and doubled quotes in quoted values. Leading zeros in accounts and tax keys are
preserved. Unused columns remain empty.

Supported fields and limits inherited from the Grids implementation:

| Field | Supported values |
|---|---|
| `consultantNumber` | 4–7 digits, no leading zero, at least 1001 |
| `clientNumber` | 1–5 digits, no leading zero |
| `accountLength` | Integer from 4 through 8 |
| Fiscal, period, and document dates | Real ISO dates in 2000–2099; period within one fiscal year; document within period |
| `label` | 1–30 characters; Unicode letters/numbers, `_`, `.`, `-`, `/`, spaces |
| `finalize` | Required boolean; controls DATEV import finalization |
| `amount` | `0.01` through `9999999999.99` |
| `direction` | `S` or `H`; credits use the appropriate side, not a negative amount |
| `account`, `counterAccount` | 1–9 digits, not all zero; at most `accountLength + 1` digits |
| `documentNumber` | 1–36 ASCII letters/digits or `_$&%*+-/` |
| `documentGuid` | Optional Belegtransfer document GUID (since 0.36.0); 36 characters, hex 8-4-4-4-12, no braces; case preserved |
| `text` | Optional, at most 60 characters |
| `taxKey` | Optional, exactly four digits |
| `costCenter1`, `costCenter2` | Optional, up to 36 Unicode letters/numbers, underscores, spaces |

The extracted API additionally accepts optional `applicationInformation`, up to
16 characters, in header field 31. Text fields reject controls and unpaired
surrogates. `createdAt` must also be in 2000–2099. Empty batches and unsupported
fields fail. No accounting balance or tax-code meaning is inferred or checked.

### Link a posting to its document image

Since 0.36.0, set `documentGuid` on each row that should open a transferred
image. Pass only the GUID, for example `"E0A08953-FBAA-4054-AF36-993D5D68F040"`,
using exactly the same spelling as `document.guid` in the Belegtransfer package.
Omit it to leave column 20 empty; an empty string, braces, a compact GUID or a
preformatted `BEDI` link fails validation at `["rows", index, "documentGuid"]`.
Both upper- and lowercase hex are accepted without conversion.

The cell value is `BEDI "E0A08953-FBAA-4054-AF36-993D5D68F040"`. Its exact CSV
representation, including the outer quotes and doubled inner quotes, is:

```csv
"BEDI ""E0A08953-FBAA-4054-AF36-993D5D68F040"""
```

Source (checked 2026-11-19): [DATEV format description, Booking batch, field 20](https://developer.datev.de/de/file-formats/details/datev-format/format-description/booking-batch).
DATEV explicitly specifies `BEDI`, one separating space, quoted GUID and doubled
quotes. This cell format is documented, not an assumption. GUID shape and both
hex cases follow `p10037` in DATEV's [Document_types_v060.xsd archive](https://developer.datev.de/assets/XSD_3c866dbe96.zip).
The CSV description does not explicitly guarantee case-insensitive lookup; the
library preserves the supplied case, so reuse the same GUID in both files.

See [image-only Belegtransfer](./datev-xml.md#transfer-images-and-link-monthly-bookings)
and the [combined example](../examples/datev-beleglink.ts). Applications own
GUID generation, persistence, matching documents to rows and import order.

**Release verification note:** Ein Testimport in DATEV ist hier nicht möglich; die Kanzlei muss einmal Testimport plus Beleglink prüfen.

## Generate SEPA credit transfers

```ts
import { sepa } from "@k2b/stdlib/finance";

const result = sepa.serialize({
  format: "sepa-sct-pain.001.001.09-gbic-5",
  currency: "EUR",
  createdAt: "2026-09-11T12:34:56.000Z",
  messageId: "example-batch-1",
  paymentInformationId: "example-payment-1",
  debtorName: "Example & Partners",
  debtorIban: "DE89370400440532013000",
  executionDate: "2026-09-14",
  rows: [
    {
      endToEndId: "example-transfer-1", amount: "12.30",
      creditorName: "Recipient (Example)", creditorIban: "NL91ABNA0417164300",
      remittance: "Example 'train' & meal",
    },
    {
      endToEndId: "example-transfer-2", amount: "0.01",
      creditorName: "Second recipient", creditorIban: "NL91ABNA0417164300",
      creditorBic: "ABNANL2A", remittance: "Example adjustment",
    },
  ],
});
if (!result.ok) throw new Error(JSON.stringify(result.error));
result.data.bytes;        // UTF-8 XML; inputs checked, no runtime XSD check
result.data.rowCount;     // 2
result.data.total;        // "12.31"
```

These accounts and IDs illustrate syntax only; do not submit the example files.

This API generates ordinary SCT in EUR using pain.001.001.09, DK GBIC 5, with one
`PmtInf` block, one debtor, one execution date, `TRF`, `SEPA`, `SLEV`, and batch
booking enabled. It does not support instant payments, direct debits, addresses,
other currencies, multiple debtors, or structured remittance information.

| Field | Supported values |
|---|---|
| Message, payment-information, and end-to-end IDs | 1–35 basic SEPA characters; no leading/trailing slash or `//` |
| `endToEndId` | Unique within the file; no persistent duplicate protection |
| `debtorName`, `creditorName` | 1–70 characters |
| `debtorIban`, `creditorIban` | Canonical uppercase SEPA IBAN; structure and checksum checked; no spaces or QR-IBANs |
| `debtorBic`, `creditorBic` | Optional valid BIC, at most 11 characters |
| `executionDate` | Real ISO date, year 0001–9999, preserved without moving it to today |
| `amount` | `0.01` through `999999999.99` |
| `remittance` | Required unstructured text, 1–140 characters |

Names and remittance accept the DK Appendix 3 v3.9 section 2.1 repertoire:
ASCII letters/digits, spaces, `+ ? / : ( ) . , ' -`, and the German extensions
`Ä Ö Ü ä ö ü ß & * $ %`. Unsupported characters (including double quotes, angle
brackets, other accented letters, and emoji) and blank-only values fail with
field paths. Accepted text is preserved and XML-escaped, never transliterated.
Past-execution-date warnings remain application policy.

Without a debtor BIC, the existing protocol placeholder
`<Othr><Id>NOTPROVIDED</Id></Othr>` is emitted; without a creditor BIC, `CdtrAgt` is
omitted. No bank data is invented. Bank acceptance, account ownership, successful
import, and payment execution are not guaranteed by input or schema validation.

## Optional full XSD validation

Import the checker explicitly wherever full schema validation is required:

```ts
import { sepa } from "@k2b/stdlib/finance";
import { validateSepaXml, sepaSchemaSha256 } from "@k2b/stdlib/finance/validate";

const file = sepa.serialize(batch); // batch: SepaBatch
if (!file.ok) throw new Error(JSON.stringify(file.error));

const validation = await validateSepaXml(
  new TextDecoder().decode(file.data.bytes),
);
if (!validation.ok) throw new Error(JSON.stringify(validation.error));

// Only after success: persist these exact bytes and, if needed, the schema hash.
await storeValidatedFile(file.data.bytes, sepaSchemaSha256); // application function
```

A successful serialization result means the supported input rules passed.
It does not claim XSD validation. If your application requires that check,
treat every failed validation (including unavailable WASM) as a failure; never
silently fall back to unchecked output. The serializer and validator are usable
independently. Tests validate generated examples and boundary values against the
pinned XSD regardless of whether consumers choose runtime validation.

## Offline validation and runtime requirements

The pinned XSD is the existing Grids copy of `pain.001.001.09_GBIC_5.xsd`, from
[DK supplementary documents](https://www.ebics.de/de/datenformate/ergaenzende-dokumente),
archive `DK-TVS_SEPA_GBIC_5zzglISO_Originale.zip`, retrieved by the Cloud project on
11 September 2026. The original header is dated 1 April 2025. Comments and
annotations are retained, with LF line endings. It is embedded as a TypeScript
string to avoid filesystem or schema-fetch requirements.

SHA-256: `35cfe972a636392704fd930c3e0496fc05b95ff891deb635b168dcdabf3c08a3`.

Every schema check verifies that hash. Validation uses `libxml2-wasm@0.6.0` with
`XML_PARSE_NONET`, `XML_PARSE_NO_XXE`, and `XML_PARSE_NO_SYS_CATALOG`. No external
input provider is installed. DTD, CDATA, and comments are rejected before parsing;
XInclude is not processed and schema-location hints do not replace the local XSD.
The checked schema has no imports or includes. XML, validator, and schema objects
are disposed after each call; global parser configuration is not changed.

`validateSepaXml` checks schema validity only: the DK schema covers more features
than this serializer and does not enforce control-sum equality or application
identity policy. Use `serialize` for the supported SCT subset, typed input checks,
and computed totals; call `validateSepaXml` separately for XSD validation.

Bun, Chromium, and a browser Web Worker are verified. Modern Web Crypto and
WebAssembly are required for schema validation. The validator's WASM is embedded
in its JavaScript package; no separate runtime WASM download is needed.

Ordinary finance browser builds need no special configuration. Only when
bundling the optional validator, keep its conditional Node-only `module` import
external. Splitting keeps the dynamically loaded engine in a separate chunk:

```ts
await Bun.build({
  entrypoints: ["./app.ts"],
  target: "browser",
  splitting: true,
  external: ["module"],
  outdir: "./dist",
});
```

This setting does not supply a browser polyfill. The import occurs only in the
validator's Node branch. Other bundlers must handle that conditional import too.
Applications own memory/input budgets; Grids' 10,000-row and 5 MiB limits are not
format rules and are not imposed by this serializer. Both serializers build the
whole file in memory.

See the runnable [two-format example](../examples/finance.ts) and the
[Grids integration proposal](./finance-grids-integration.md).

For CII E-Invoice XML generation and XML/PDF reading, see [E-Invoices](./einvoice.md).

## Validate configuration before rows exist

`datev.validateHeader(unknown)` returns `FinanceResult<DatevHeader>`;
`sepa.validateHeader(unknown)` returns `FinanceResult<SepaHeader>`. These strict
objects contain the format configuration without `rows` or `createdAt`. SEPA
headers also exclude `messageId` and `paymentInformationId`. All types are
exported from `@k2b/stdlib/finance`; no internal schemas are needed.

```ts
const checked = sepa.validateHeader({
  format: "sepa-sct-pain.001.001.09-gbic-5", currency: "EUR",
  debtorName: "Example GmbH", debtorIban: "DE89370400440532013000",
  executionDate: "2026-09-14",
});
```

Header validation shares the batch's field rules and DATEV fiscal-period checks.
It does not check row dates, account lengths against individual postings,
end-to-end uniqueness, or batch totals. Assemble the complete batch with real
runtime metadata and run `validate` or `serialize` again. Unknown fields fail;
project application configuration to the public header shape first.

See [finance conformance and migration](./finance-conformance.md) for independent
checks, supported boundaries, and the Grids replacement contract.
