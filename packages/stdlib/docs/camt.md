# Read camt.052 account reports

`camt.parse(xml)` reads **camt.052.001.08** account reports from any bank using
that namespace. It detects the version from the document, without a bank setting.
Other versions, camt.053/054, ZIP archives and transport envelopes are unsupported.
Pass the standalone `<Document>` XML as a decoded string.

```sh
bun add @k2b/stdlib zod@^4.4.3 ibantools@^4.5.4 saxes@^6.0.0
```

The finance subpath uses these optional peers. Reading runs synchronously in
pure JavaScript in Bun, browsers and Web Workers. WASM and DOM APIs are not
required. The root stdlib import does not load finance or its peers.

```ts
import { camt } from "@k2b/stdlib/finance";

const result = camt.parse(xml); // xml: string, e.g. await file.text()
if (!result.ok) {
  console.error(result.error.code, result.error.issues);
} else {
  console.log(result.data.version); // "camt.052.001.08"
  for (const report of result.data.reports) {
    console.log(report.account.id, report.balances);
    for (const entry of report.entries) {
      console.log(entry.amount, entry.direction, entry.status);
      // { amount: "125.50", currency: "EUR" }, "DBIT", { kind: "code", value: "BOOK" }
      for (const group of entry.details) {
        for (const transaction of group.transactions) {
          console.log(transaction.references.endToEndId);
          console.log(transaction.creditor?.name);
          console.log(transaction.remittance.unstructured);
        }
      }
    }
  }
}
```

See the runnable [synthetic report and reader](../examples/camt.ts). Its account
identifiers are examples. No private bank data is included in the tests.

## Interpret the result

`parse` returns `FinanceResult<CamtDocument>`, following the same Result contract
as the [DATEV/SEPA API](./finance.md). All public types are exported from
`@k2b/stdlib/finance`. Missing optional values are `undefined`; repeated values
are arrays, including empty arrays. The result is JSON-serializable and contains
no Decimal, Date, DOM or parser-library objects.

| Level | Typed fields |
|---|---|
| Document | Version, message ID, creation timestamp, optional message pagination, reports, complete XML element tree |
| Report | ID, optional timestamp, electronic/legal sequence numbers, pagination, period, copy/duplicate marker, account, balances, entries, additional information |
| Account | IBAN or proprietary ID, optional currency, name, owner name and servicer BIC |
| Balance | Standard/proprietary type and subtype, amount, credit/debit direction, date or date-time |
| Entry | Amount, direction, status, bank transaction code, optional reference, reversal, booking/value date, servicer reference, additional information, detail groups |
| Detail group | Optional batch metadata (message/payment ID, count, total, direction), transactions |
| Transaction | Optional amount/direction, references, instructed/transaction/counter-value amounts, bank transaction code, debtor/creditor and their accounts, ultimate parties, agent BICs, purpose, remittance, return information and additional information |

References include message, payment-information, instruction, end-to-end,
transaction, mandate, cheque, clearing-system, account-owner, account-servicer,
market-infrastructure and processing IDs, UETR, and repeated proprietary
references. `NOTPROVIDED` stays a literal value; it is not an inferred unique ID.

Parties distinguish `kind: "party"` from `kind: "agent"`. IBANs and BICs are
reported as supplied, without checksum validation or lookup. A missing counterparty
is not reconstructed from the remittance text.

### Amounts and batch breakdowns

Amounts are unsigned **decimal strings**, accompanied by their own currency.
Direction is separate: `CRDT` or `DBIT`. Reversal is an independent optional
boolean; it does not flip the direction. There is no currency conversion,
rounding, sum calculation or automatic conversion to `money` minor units.

For example, an entry of `125.50` with transaction details `100.00` and `25.50`
is one account movement with a breakdown. Adding the entry and its details would
double-count it. A transaction may have no explicit amount or direction; the
reader leaves those absent instead of copying the entry's total into each row.
Likewise, instructed and counter-value amounts can have different currencies and
must not be summed with the booked amount.

The reader accepts XML decimal notation without exponents, including integers,
leading zeros and a leading plus. It normalizes the sign/leading integer zeros
using string operations: `+00012.300` becomes `12.300`. Fractional zeros remain.
Negative amounts other than zero are rejected. The XSD's 18 total digits and
5 fractional digits are checked on the value, ignoring insignificant zeros.
Currency precision is not forced to two decimal places; a KWD amount or an FX
amount can carry additional precision.

### Dates, status and pagination

Dates retain whether the source used `Dt` or `DtTm`:

```ts
{ kind: "date", value: "2026-09-13" }
{ kind: "dateTime", value: "2026-09-13T23:59:59.123456-04:00" }
```

Time zones and fractional precision are preserved. Local date-times do not gain
an inferred time zone. Typed date fields support years 0001–9999, real calendar
dates, optional XML time-zone offsets, and `24:00:00` for midnight. They are not
converted to JavaScript Date objects.

Entry status can be standard or proprietary. Pending entries are not final
payments. Reports may contain no entries, and no balance equation is inferred
from the selected balances and entries. Message/report pagination and sequence
numbers are preserved as strings; the reader does not fetch missing pages,
merge files or deduplicate repeated intraday reports. The application owns
those decisions and persistent duplicate protection.

### Fields outside the typed projection

`result.data.document` preserves **all elements, attributes and text**, including
namespaces and child order. Its `CamtXmlElement` shape is:

```ts
type CamtXmlElement = {
  name: string;       // local name, independent of XML prefix
  namespace: string; // resolved namespace URI
  attributes: { name: string; namespace: string; value: string }[];
  content: (string | CamtXmlElement)[];
};
```

Structured remittance is also exposed as `remittance.structured`, an array of
these elements. Return information is available in the same form. Fields such
as addresses, charges, interest, securities, exchange-rate details, transaction
summaries and supplementary data remain accessible through the complete tree;
they are not all mapped to dedicated properties. Attribute/text values stay
strings. XML entities are decoded, CDATA becomes text, and comments/processing
instructions are omitted. This tree is not a byte-preserving XML roundtrip.

## Validate against the official XSD when required

The reader checks XML well-formedness, namespace, required projected fields,
scalar multiplicity, choices, amounts, dates and resource limits. **Successful
parsing is not a claim of full XSD validity.** Unknown/unprojected elements remain
in the tree; element order and every restriction of the full ISO message are not
checked by the projection.

For full XSD validation, install the optional WASM peer and invoke the checker:

```sh
bun add libxml2-wasm@0.6.0
```

```ts
import { camt } from "@k2b/stdlib/finance";
import { validateCamtXml, camtSchemaSha256 } from "@k2b/stdlib/finance/validate";

const validation = await validateCamtXml(xml);
if (!validation.ok) throw new Error(JSON.stringify(validation.error));

const parsed = camt.parse(xml);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
// Consume parsed.data. Record camtSchemaSha256 if your audit requires it.
```

The checker targets the ISO `.08` schema, not a bank-specific usage profile or
DK subset. It does not establish account ownership, reconcile invoices, infer
payment success or guarantee completeness of a bank feed. Both APIs reject DTDs
and unsupported namespaces. The checker accepts comments and CDATA, does not
resolve external entities or fetch schemas, and ignores schema-location hints
in favor of the pinned schema. Web Crypto and WebAssembly are required only for
this explicit check. See [optional-validator bundling](./finance.md#offline-validation-and-runtime-requirements)
for Bun browser builds; the pure JS reader needs no special bundler settings.

## Errors and resource limits

Errors contain no partial report. `FinanceIssue.path` uses XML local names and
zero-based occurrence indices, for example:

```ts
["xml", "Document", "BkToCstmrAcctRpt", 0, "Rpt", 0, "Ntry", 1, "Amt", 0]
```

Missing/duplicate fields point to their parent. Parser/projection issues include
one-based line/column positions when available (the parser's position at the tag
or failure). XSD errors use `["xml"]` and the engine's available source location.
Use issue codes and paths rather than depending on diagnostic message wording.

| Issue code | Meaning |
|---|---|
| `unsupported_format` | Root element/namespace is not the supported camt.052 version |
| `invalid_xml` | Malformed XML, unsupported XML version, or forbidden DTD |
| `invalid_input` | Invalid or missing projected field, duplicate scalar, or invalid limit option |
| `input_limit` | Input length, element count or nesting limit exceeded |
| `schema_mismatch` | Full optional XSD check failed |
| `schema_integrity` | Embedded XSD no longer matches its expected hash |
| `validator_unavailable` | Required optional checker dependencies/runtime are unavailable |

Input errors return `BAD_INPUT`/400. Checker availability/integrity errors return
`INTERNAL`/500. Missing import-time finance peers follow the runtime's normal
module-resolution error behavior; install the peers shown above.

Both APIs accept the same optional limits:

```ts
const limits = {
  maxCharacters: 10 * 1024 * 1024, // JS UTF-16 code units, not file bytes
  maxElements: 250_000,
  maxDepth: 64,
};
camt.parse(xml, limits);
await validateCamtXml(xml, limits);
```

These are defaults. Overrides must be positive safe integers. Choose limits for
your import workload; also bound uploads before decoding them. The reader builds
the complete tree in memory and is not a streaming import API. XML text should
already be decoded according to its file encoding. An `AppHdr` or a surrounding
transport envelope must be separated by the application's transport layer.

## Schema and verification sources

The schema was downloaded directly from
[ISO 20022's camt.052.001.08 XSD](https://www.iso20022.org/sites/default/files/documents/messages/camt/schemas/camt.052.001.08.xsd)
on 13 September 2026. Its generated header is dated 14 February 2019. The embedded
copy preserves content with LF-normalized line endings, has no imports/includes,
and is SHA-256 checked on every validation:

`589b55980dd6e553de78ba036eb733308da201bda4c3158e10b22cb003911e8f`

Tests include a synthetic report with multiple entries and transactions plus two
public MNB examples, downloaded on 13 September 2026. For each MNB fixture, only
the `<Document>` portion of the published `AppHdr` + `Document` fragment was
retained, with LF line endings and one trailing newline:

| Source | Local fixture | SHA-256 |
|---|---|---|
| [MNB Type 1](https://www.mnb.hu/letoltes/camt-052-001-08-type1.txt) | [camt-mnb-type1.xml](../examples/fixtures/camt-mnb-type1.xml) | `2cf8be8747ce24e7325d2e746abea581a16b0027d150d5d5bac6f4dc7cf3d44f` |
| [MNB VIBER 1](https://www.mnb.hu/letoltes/camt-052-001-08-1-viber.txt) | [camt-mnb-viber1.xml](../examples/fixtures/camt-mnb-viber1.xml) | `5c128a4111fc0a1b90e235dcf0fba1ce3d34fd27a4b8b9e3733774df10ccaada` |

No Sparkasse Neu-Ulm–Illertissen export has been supplied or verified. Support is
based on the ISO namespace and tested examples, not a bank-name allowlist.
The JS XML parser dependency is saxes 6 (XML/namespace-aware, no external entity
resolution); its upstream repository is archived. Keep malformed-input and
runtime regression tests when changing that dependency.
