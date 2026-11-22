# Generate and read E-Invoice XML

Use `einvoice` from `@k2b/stdlib/finance` for the supported CII EN16931 slice.
It generates XML and reads XML or an embedded PDF attachment. It does not render
PDFs or import records into an accounting system.

## Supported invoices

The generation format is `zugferd-2.5-en16931`, pinned to the ZUGFeRD 2.5 /
Factur-X 1.09 EN16931 XSD distribution. The XML uses CII namespaces and guideline
`urn:cen.eu:en16931:2017`. This guideline does not identify the precise standard
release of an incoming document: the returned `format` identifies the stdlib
reader contract, not proof that a sender used version 2.5.

The slice supports EUR invoices, positive credit notes referring to an earlier
invoice, and self-billing (including self-billed credit notes). It requires seller and buyer names and addresses,
buyer reference and due date. Service date, invoicing period and payment
instructions are optional. Seller always means supplier, including in self-billing. Notes are
preserved as text; the reader does not infer agreement references from prose.

From 0.32.0, seller and buyer `address.line1` (BT-35/BT-50) may be omitted or
`""`. Nonempty values retain the 200-character and XML 1.0 text checks;
whitespace-only values are rejected. The writer omits `LineOne` when no content
is supplied. Country, city and postcode remain required in this slice.
The strict XML and PDF readers return `line1: undefined` for a missing `LineOne`.
Consumers of `Invoice` or `ParsedInvoice.invoice` must check for presence before
using string methods, or use `line1 ?? ""` when displaying an optional line.
No address line is invented; visible PDF rendering remains caller-owned.

Positions support names, optional descriptions, positive quantities, unit prices
of zero or more, and units `C62`, `HUR`, `DAY`, `KGM`. From version 0.26.0, VAT
categories are `S`, `Z`, `E`, `AE`, `K`, `G`, and `O`; omitted `taxCategory` means
`S`. Existing S inputs and their generated XML remain unchanged. The caller
determines the applicable category and rate.

These are the generation and default reader limits. For broader incoming CII
documents, use the additive `mode: "incoming"` reader described below. It also
accepts CII XRechnung 3.0 and 2.3, additional payment variants, price base quantities,
adjustments and declared prepayments. UBL and generation of those additional
features remain outside this module.

## Generate XML

Pass an `Invoice` with explicit line IDs and string amounts. Start from the
[runnable example](../examples/einvoice.ts), which includes both parties and
payment details.

```ts
import { einvoice } from "@k2b/stdlib/finance";

const checked = einvoice.validate(input); // unknown -> Result<Invoice>
if (!checked.ok) throw new Error(checked.error.message);

const generated = einvoice.serialize(checked.data, {
  format: "zugferd-2.5-en16931",
});
if (!generated.ok) throw new Error(generated.error.message);

// generated.data.xml: XML string
// generated.data.bytes: the same XML encoded as UTF-8
```

`validate` and `serialize` share the same input, calculation, and consistency
checks. Both reject contradictory supplied line amounts, totals, and tax groups.
`validate` preserves the input values and does not fill optional totals. All return
the usual stdlib `Result`, with structured `error.issues` on failure.

`einvoice.calculate(lines, options?)` returns rounded lines, tax groups, net amount, tax,
gross amount and due amount. Each line is rounded half up to cents. VAT is then
rounded half up per category and numerically distinct rate. For example, S at
`19` and S at `19.00` belong to one group; E at `0` and Z at `0` are separate. No calculation converts amounts to JavaScript numbers.

Quantities, unit prices and rates accept up to four decimal places and at most
200 characters. Prices retain those decimal places in XML: `1.0050` stays
`1.0050`, even when the line amount rounds to `1.01`. Totals use exactly two
decimal places. Generation and `validate` limit the calculated gross total and amount due to
`9999999999.99` EUR. This is a tested library boundary, not an EN16931 legal
maximum: the official Schematron has floating-point sum checks that can fail at
extreme scales. `calculate` retains its larger exact-decimal range. Limits include 1,000 lines and 100 notes. Text fields reject
invalid XML characters; unknown input fields are rejected.

## Explicit payment rounding (BT-114)

Available since version 0.31.0. Supply `roundingAmount` explicitly when
the agreed amount due differs from the calculated gross total. Net line prices
and VAT remain calculated as above. The library does not infer net prices from
a gross target or choose a payment adjustment for you.

```ts
const result = einvoice.calculate([
  { id: "1", name: "Item", quantity: "1", unitPrice: "84.03",
    unitCode: "C62", taxRate: "19" },
], { roundingAmount: "-0.01" });
if (!result.ok) throw new Error(result.error.message);
const { lines, ...totals } = result.data;
const roundedInvoice = { ...invoice, lines, totals };
// netAmount 84.03, taxAmount 15.97, grossAmount 100.00, dueAmount 99.99
const file = einvoice.serialize(roundedInvoice, { format: "zugferd-2.5-en16931" });
```

The public `InvoiceCalculationOptions` type describes the optional second
argument. Transfer the returned totals to `Invoice.totals`, including
`roundingAmount`, for `validate` and `serialize`:

- `grossAmount` (BT-112) is net plus the sum of rounded tax groups.
- `roundingAmount` (BT-114) is a signed decimal string with exactly two decimal
  places: `"-0.01"`, `"0.01"`, or `"0.00"`. No plus sign, negative zero, exponent,
  or leading zeros are accepted.
- `dueAmount` (BT-115) is gross plus rounding. Prepayments remain unsupported.
  A negative amount due is rejected. Generation limits gross and due to
  `9999999999.99` EUR; this is a library limit, not a legal rounding allowance.

For an otherwise valid generated invoice, the supported adjustment range is
`-grossAmount <= roundingAmount <= 9999999999.99 - grossAmount`, in whole cents.
`calculate` enforces the nonnegative due amount but retains its larger decimal
range; `validate` and `serialize` also enforce the output maximum. There is no
additional fixed ±0.01 or ±1.00 allowance. These are arithmetic and library
bounds, not permission to use any amount in that range as payment rounding.
The caller must derive and justify the adjustment from the agreed payment
amount. Schematron's VAT tolerance does not set this business limit and cannot
justify replacing a discount, charge, or incorrect tax basis with BT-114.

Omitting the option preserves the previous result shape and XML bytes. An
explicit `"0.00"` emits the field. The strict reader preserves it, and a generated
invoice passes `parseXml` → `validate` → `serialize` without changing XML bytes.
Parsing alone still preserves inconsistent sums; validation and generation
reject them. Rounding cannot compensate for an incorrect tax group or gross
sum. There is no automatic distribution across lines or tax groups.

These examples start from **explicitly chosen net amounts**:

| Net basis | VAT rate | Calculated VAT | Gross | Rounding | Due |
|---|---|---|---|---|---|
| 0.03 | 19% | 0.01 | 0.04 | -0.01 | 0.03 |
| 84.03 | 19% | 15.97 | 100.00 | -0.01 | 99.99 |
| 44.03 + 49.04 | 19% | 17.68 | 110.75 | 0.00 | 110.75 |
| 0.07 | 7% | 0.00 | 0.07 | +0.01 | 0.08 |
| 0.02 | 20% | 0.00 | 0.02 | +0.01 | 0.03 |
| 0.03 | 20% | 0.01 | 0.04 | -0.01 | 0.03 |
| 84.03 at 19% + 93.45 at 7% + 0.02 at 20% | mixed | 22.51 | 200.01 | 0.00 | 200.01 |

At 20%, splitting 0.03 by rounding the included tax first produces net 0.02 and
tax 0.01. Choosing net 0.02 for this writer instead produces tax 0.00 and adds
0.01 payment rounding. Choosing net 0.03 produces tax 0.01 and subtracts 0.01.
**Neither is the original gross split:** the caller must choose and display the
new tax presentation explicitly. Existing `money.taxFromGross` remains net-first
and unchanged. Incoming invoices are not recalculated or migrated.

The same positive-amount model applies to invoice (380), selfBilling (389),
creditNote (381), and selfBillingCreditNote (261). A credit reverses the economic
effect; its lines, VAT and amount due remain positive, with the same rounding
sign as the corresponding positive invoice. For example, a 0.03 credit at a
chosen net basis of 0.02 and 20% has VAT 0.00 and rounding +0.01. Both credit kinds
require `precedingInvoice`; signed negative lines remain unsupported. Do not
negate a credit's rounding independently of its other amounts.

[Runnable example](../examples/einvoice-payment-rounding.ts).
The arithmetic follows BR-CO-15/16/17 and BR-S-09; BT-114 has at most two decimals
under BR-DEC-17. See [conformance checks](./finance-conformance.md). Passing the
pinned EN16931 core rules does not establish a national tax treatment or CIUS
acceptance. The caller owns the economic reason for the adjustment and keeps
PDF, accounting and payment records consistent with these declared amounts.

## Payment instructions, periods and corrections (0.27.0)

`payment` is optional. Omit it to emit no payment instruction, for example when
a credit note does not instruct the customer to pay the seller. A supplied
payment defaults to code `58`, preserving the XML bytes of existing inputs.

| `payment.typeCode` | Meaning | Account in this writer |
|---|---|---|
| `58` (default) | SEPA credit transfer | Valid `iban` required |
| `30` | Credit transfer | Valid `iban` required |
| `10` | Cash | Omit bank details |
| `68` | Online payment service, such as PayPal | Omit bank details |
| `97` | Clearing between partners | Omit bank details |

Codes follow [UNTDID 4461](https://docs.peppol.eu/poacc/billing/3.0/codelist/UNCL4461/).
Code 97 represents offsetting mutual amounts owed; it does not mean that a
payment has already been made. Optional `information` maps to BT-82.
`accountName` is optional for transfers. For other supported codes this writer
rejects `iban` and `accountName` as a library boundary, not as a general EN16931
prohibition. Card and direct-debit generation remain unsupported.

Local validation requires an IBAN for 30/58 even when the entire account is
missing. This closes a gap in the pinned CII Schematron: BR-50/61 are evaluated
in an account-element context. The XML reader requires a code when payment
means exist (BR-49); unknown or unsupported codes fail. An empty `payment: {}`
is invalid because it defaults to a transfer without an account.

```ts
const cash = { ...invoice, payment: { typeCode: "10" as const } };
const paypal = { ...invoice, payment: { typeCode: "68" as const, information: "PayPal" } };
const clearing = { ...invoice, payment: { typeCode: "97" as const } };
const withoutPayment = { ...invoice, payment: undefined };
const byPeriod = {
  ...invoice, serviceDate: undefined,
  period: { startDate: "2026-08-01", endDate: "2026-08-15" },
};
```

A header `period` has optional `startDate` and `endDate` (BT-73/74). At least one
must exist (BR-CO-19), and the end must not precede the start (BR-29). All dates
must be real calendar dates. A service date and period may coexist. Only VAT
category K requires at least one of them in this slice.

Use a regular `invoice` (380) with `precedingInvoice` for an additional charge;
its lines contain only the additional amounts. A reducing correction remains
`creditNote` (381), with positive credited amounts and a required reference.
An additional self-billed amount uses `selfBilling` (389) with the original
reference. A reducing self-billed credit note uses `selfBillingCreditNote` (261)
with positive credited amounts and a required reference. Seller still means supplier. These reference-bearing documents do
not replace the original invoice. The
[UNTDID 1001 descriptions](https://docs.peppol.eu/poacc/billing/3.0/codelist/UNCL1001-inv/)
distinguish 384 as a corrected invoice with revised information; this API does
not introduce replacement-invoice semantics. The [self-billing codelist](https://docs.peppol.eu/poacc/self-billing/3.0/bis-sb/)
distinguishes buyer-issued invoices (389) from buyer-issued credit notes (261);
both codes also pass the pinned EN16931 CII validation.

```ts
const reference = { number: "ORIGINAL", invoiceDate: "2026-08-01" };
const additional = { ...invoice, precedingInvoice: reference }; // 380
const reduction = {
  ...invoice, kind: "creditNote" as const,
  precedingInvoice: reference, payment: undefined,
}; // 381
const selfBilledAddition = {
  ...invoice, kind: "selfBilling" as const, precedingInvoice: reference,
}; // 389
const selfBilledReduction = { ...reduction, kind: "selfBillingCreditNote" as const }; // 261
```

Each reference requires a nonempty `number` (BT-25, BR-55) and `invoiceDate`
(BT-26, required by this API). The original date must not follow the new invoice
date. See the [complete correction examples](../examples/einvoice-options.ts).

**Migration:** Existing inputs remain valid and retain their generated XML
bytes. `Invoice.payment` and `Invoice.serviceDate` are now optional, including
on the return value of the default `parseXml` and `parsePdf`. Check presence
before accessing them. `payment.iban` and `accountName` are also optional in the
TypeScript type; validation enforces account requirements by payment code.
The default reader returns the explicit `typeCode`, including `58`, and returns
periods and references for all four document kinds. Handle the new `selfBillingCreditNote` kind in
exhaustive switches.

## VAT categories and exemption reasons

`InvoiceLine` and `InvoiceTotals.taxGroups` accept optional `taxCategory`,
`taxExemptionReason` (BT-120), and `taxExemptionReasonCode` (BT-121). Reasons belong
to the tax group in XML. Supply them on lines for automatic calculation, or on
explicit `totals.taxGroups`. The reader returns them on both groups and their
matching lines. Reasons supplied in several places must agree; differing reasons
never create additional groups for the same category and rate.

| Category | Meaning | API rate | Group reason |
|---|---|---|---|
| `S` (default) | Standard VAT | Greater than 0, at most 100 | Forbidden |
| `Z` | Zero rated | `"0"` | Forbidden (BR-Z-10) |
| `E` | Exempt, including margin-scheme representation | `"0"` | Text and/or matching VATEX code |
| `AE` | Reverse charge | `"0"` | Text and/or `VATEX-EU-AE` |
| `K` | Intra-community supply | `"0"` | Text and/or `VATEX-EU-IC` |
| `G` | Export outside the EU | `"0"` | Text and/or `VATEX-EU-G` |
| `O` | Outside the scope of VAT | `"0"`; XML omits the rate | Text and/or `VATEX-EU-O` |

All non-S groups have zero disclosed tax. Text must describe the applicable
reason; the library checks presence, not the legal meaning of arbitrary prose.
Codes are checked against the VATEX list in EN16931 validation 1.3.16 and must
match their category. The API preserves their spelling. Local tax eligibility
and the interpretation of exemption text remain with the caller.

Mixed S+E invoices are supported. O must be the only category in its invoice.
Each non-S category has exactly one group. Equivalent decimal zero rates are
accepted; reading O normalizes the absent XML rate to `"0"`.

`vatId` remains a required string to preserve existing TypeScript consumers.
Use `""` when no VAT identifier is present; XML omits that registration and the
reader returns `""` when it is absent. O requires empty seller and buyer VAT IDs.
Other categories require a seller VAT ID, or `seller.taxRegistrationId` (BT-32)
for S/Z/E/AE. K/G require the seller VAT ID. A seller without a VAT ID also needs
`seller.id` (BT-29, BR-CO-26). Optional `buyer.id` represents BT-46.
AE/K require a buyer VAT ID in this slice; other categories allow an empty buyer
VAT ID. Alternative legal-registration or tax-representative identities are not
supported. Buyer tax registration is not supported.

K also requires `deliverToCountryCode` (BT-80); set the actual destination rather
than assuming the buyer's address is the destination. Supply `serviceDate` (BT-72) or a nonempty header `period` (BG-14), as required
by BR-IC-11.

`calculate(lines)` checks categories, rates, and conflicting supplied reasons,
but does not require a reason or party data: these may be supplied when the
invoice is assembled. `validate` and `serialize` require complete groups and
identities, and verify supplied amounts. Parsing checks category constraints and
group membership, while preserving declared arithmetic for subsequent validation.

### Differenzbesteuerung under § 25a UStG

Use category E with zero disclosed VAT and the applicable margin-scheme code:

| Goods | VATEX code | German invoice wording |
|---|---|---|
| Second-hand goods | `VATEX-EU-F` | Gebrauchtgegenstände/Sonderregelung |
| Works of art | `VATEX-EU-I` | Kunstgegenstände/Sonderregelung |
| Collectors' items and antiques | `VATEX-EU-J` | Sammlungsstücke und Antiquitäten/Sonderregelung |

The [VATEX list](https://docs.peppol.eu/poacc/billing/3.0/codelist/vatex/)
assigns these codes to E. The wording comes from
[§ 14a(6) UStG](https://www.gesetze-im-internet.de/ustg_1980/__14a.html).
The European Commission maintains the
[official code-list registry](https://ec.europa.eu/digital-building-blocks/sites/spaces/DIGITAL/pages/467108974/Registry+of+supporting+artefacts+to+implement+EN16931).

Starting with the complete invoice in the [base example](../examples/einvoice.ts):

```ts
import { einvoice, type Invoice } from "@k2b/stdlib/finance";

const marginInvoice: Invoice = {
  ...invoice,
  lines: [{
    id: "1", name: "Antiker Schrank", quantity: "1", unitPrice: "1200.00",
    unitCode: "C62", taxCategory: "E", taxRate: "0",
    taxExemptionReason: "Sammlungsstücke und Antiquitäten/Sonderregelung (§ 25a UStG)",
    taxExemptionReasonCode: "VATEX-EU-J",
  }],
};
const result = einvoice.serialize(marginInvoice, {
  format: "zugferd-2.5-en16931",
});
```

The [runnable margin example](../examples/einvoice-margin.ts) produces a total of
EUR 1,200.00 and disclosed tax of EUR 0.00. `unitPrice` is the full selling price,
including any VAT contained in the margin. E is the invoice representation; it
does not mean the dealer owes no margin VAT. This module neither calculates the
internal margin nor reports it separately on the invoice.

If several exempt lines need different explanations, supply one combined text
on their shared E group (or the same combined text on each line) and omit a code
that would describe only some of them. Keep item-specific details in descriptions.
Conflicting F/I/J codes on separate E lines are rejected rather than silently
choosing one code or emitting multiple E groups (BR-E-01).

## Read XML or PDF

For independent invoices, select the incoming model explicitly:

```ts
const parsed = einvoice.parseXml(xml, { mode: "incoming" });
const embedded = await einvoice.parsePdf(pdfBytes, { mode: "incoming" });
if (!parsed.ok) throw new Error(parsed.error.message);

const { invoice, unmapped } = parsed.data;
// invoice.payments: all payment means, possibly empty
// invoice.serviceDate / paymentTerms / buyerReference: optional
// invoice.lines[].priceBasis: optional quantity and optional unit
// invoice.adjustments and lines[].adjustments: declared allowances/charges
// invoice.totals: declared totals, including optional prepaid/rounding amounts
// unmapped: supplementary elements/attributes with namespace-aware XML paths
```

The incoming overload returns `ParsedIncomingInvoice` with `format: "cii-en16931"`,
`invoice`, unchanged original `xml`, `profile`, and `unmapped`. PDF results also
contain `filename`. It recognizes the EN16931 guideline and these exact CII CIUS
identifiers:

- `urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`
- `urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_2.3`

This identifies supported extraction, not national CIUS conformance. The
[independent original-invoice regression](./einvoice-external-examples.md) checks
11 unchanged public invoices, their extracted values, XSD and EN16931 core rules.

`IncomingInvoice` preserves signed, arbitrarily precise decimal strings, other
invoice currencies, optional VAT accounting currency, multiple payment means,
periods, price bases, gross prices, adjustments, references and party identifiers.
Absent values remain `undefined`; optional empty text remains `""`. O line rates
remain absent, while a declared zero O group rate is preserved. Exemption reasons
are projected from groups to matching lines. No arithmetic is recalculated and
no missing dates, rates, identifiers or payments are invented.

The reader checks required core fields, singleton cardinalities, decimal/date
syntax, VAT categories, group membership, reasons, and relevant identities.
AE accepts a buyer legal registration ID as an alternative to the VAT ID; K
requires a buyer VAT ID, delivery country, and delivery date or invoice period.
Seller tax representative identities are supported. Contradictory line/group
reasons fail. These checks do not replace the complete EN16931 Schematron.

Unmapped supplementary fields, including attachments and product metadata, are
returned explicitly with their namespace, path, attributes and subtree. They
are not executed or decoded. Review them before using the projection for
accounting. The original `xml` is the complete source of truth; the supplementary
element tree is for inspection and does not preserve mixed-content ordering,
comments or lexical XML formatting. The incoming model is not an `Invoice` and
cannot be passed directly to the serializer without a deliberate mapping into
its narrower generation contract.

Existing calls without a mode retain the strict, backward-compatible contract:

```ts
const parsedXml = einvoice.parseXml(xml); // Result<ParsedInvoice>
const parsedPdf = await einvoice.parsePdf(pdfBytes);
```

They return the generation model and reject unsupported fields. Their declared
amounts can be checked with `einvoice.validate`, which applies the generation
slice's arithmetic. Both readers reject malformed XML, DTDs, unknown entities,
ambiguous mapped fields and invalid namespace substitutions. Prefixes, comments
and CDATA are accepted. Neither reader runs XSD or Schematron automatically.

PDF reading requires optional peer `pdf-lib@1.17.1`, loaded when `parsePdf` is
called. It searches document-level name trees and associated files for exactly
one attachment named `factur-x.xml`, `zugferd-invoice.xml` or `xrechnung.xml`
(case insensitive). A recognized filename does not imply a supported profile.
Ambiguous attachments, encrypted PDFs and invalid UTF-8 XML are rejected.
There is no OCR, PDF/A validation or comparison of visual content with XML.

Optional parser limits are `maxCharacters` (10 Mi characters), `maxElements`
(100,000), and `maxDepth` (64). PDF options also include `maxPdfBytes` (25 MiB).
These are input and XML-tree budgets, not a hard memory or CPU sandbox for
PDF parsing. Applications accepting hostile PDFs can isolate the operation in
a worker or separate process with their own resource budget.

## Validate the XML schema

```ts
import { validateInvoiceXml } from "@k2b/stdlib/finance/validate";

const schemaResult = await validateInvoiceXml(xml, {
  format: "zugferd-2.5-en16931",
  mode: "incoming", // also permit the two supported CII XRechnung identifiers
});
```

This separately loaded checker uses the pinned profile XSDs and optional
`libxml2-wasm@0.6.0`, with Web Crypto for schema integrity. It rejects DTDs before
WASM parsing and serves schema imports from a fixed in-memory map. It requires
no filesystem access or network schema fetches. Browser bundling of the WASM
peer uses `external: ["module"]` with Bun, as for the existing finance validators.

The result covers **XSD only**. It does not execute Schematron, check invoice
arithmetic, certify PDF/A, or establish legal/tax compliance. Use the model and
generation checks for this slice's arithmetic; keep any broader business-rule
validator and its version visible in application evidence.

See [schema provenance and licensing](../src/finance/einvoice-schema-NOTICE.md).

## Input checks and independent conformance

Country codes and VAT country prefixes are checked against the code lists used
by EN16931 validation 1.3.16 (including the Greek `EL` VAT prefix). Dates exclude
year zero. VAT registration existence, national checksum rules, applicable tax
rates, self-billing agreements, and the original invoice's business identity
remain application responsibilities.

The repository runs pinned official EN16931 CII Schematron with Saxon-HE in CI,
alongside the profile XSD and independent Python decimal checks. Cases include
all four document kinds, optional payment instructions and codes 10/30/58/68/97,
periods, references, all seven VAT categories, F/I/J margin schemes, mixed
S+E and zero-rate categories, equivalent rates, four-decimal prices, rounding,
zero prices, special characters, the output amount boundary, and 1,000 lines.
XSD-valid mutations with wrong sums, tax, country codes, and VAT prefixes must
fail the expected Schematron rules. Missing payment TypeCode is additionally
rejected by XSD. This is regression evidence for the
supported slice, not a universal compliance certificate.

See [finance conformance and migration](./finance-conformance.md) for pinned
sources, the local command, changed input behavior, and runtime-check policy.
