# E-Invoice slice

From `@k2b/stdlib >= 0.32.0`, seller/buyer `address.line1` is optional or empty.
The writer omits an empty `LineOne`; strict XML/PDF readers return `undefined`
when it is absent. Handle `string | undefined` in `Invoice` and parsed output.
Present text still has XML/length checks; country, city and postcode stay required.

Optional payment instructions, payment codes 10/30/58/68/97, header periods and
references on invoice/selfBilling require `@k2b/stdlib >= 0.27.0`.
VAT categories and exemption reasons require `@k2b/stdlib >= 0.26.0`.
Header APIs and strengthened format validation require `>= 0.25.0`.

Import `{ einvoice }` and `Invoice` from `@k2b/stdlib/finance`.
Read `docs/einvoice.md` in the repository for limits and the complete contract.

- `validate(unknown)` checks supported values, calculated output limits, and all
  supplied amounts/tax groups, using the same rules as serialization. It neither
  fills totals nor changes original values. Use it after parsing to check arithmetic.
- `calculate(lines, { roundingAmount? })` returns exact decimal totals, lines, and tax groups.
  Explicit signed fixed-cent BT-114 changes only `dueAmount = grossAmount + roundingAmount`;
  transfer it with the other totals to `Invoice.totals`. It never changes VAT or
  chooses a net basis from gross prices. Omission preserves the previous bytes.
  This extension requires 0.31.0; see the guide before migrating.
- `serialize(invoice, { format: "zugferd-2.5-en16931" })` generates UTF-8 XML and
  checks any supplied line amounts and totals against the calculated values.
- `parseXml(xml, options?)` and async `parsePdf(bytes, options?)` preserve incoming
  declared amounts. Parsing does not certify their arithmetic.
- `validateInvoiceXml(xml, { format: "zugferd-2.5-en16931", ...limits })` is exported
  only from `@k2b/stdlib/finance/validate`; it checks pinned XSDs, not Schematron.

The slice covers EUR CII EN16931 invoices, credit notes with an original invoice
reference, and self-billing, with S/Z/E/AE/K/G/O VAT and C62/HUR/DAY/KGM units.
The default reader rejects unsupported XML fields. Generation has no UBL, XRechnung, discounts, prepayments,
OCR, PDF rendering or PDF/A certification. Profile URNs cannot
establish the exact release of an incoming document.

Keep amounts as strings. Round each line half up to cents, then VAT per category and rate.
Preserve unit-price precision (up to four decimal places). Never convert through
Number or copy Cloud's former Factur-X numeric mapping.

PDF reading loads optional `pdf-lib@1.17.1`. XSD validation loads optional
`libxml2-wasm@0.6.0`. Pure XML operations do not execute either runtime.
Cloud owns snapshot mapping, numbering, HTML/Gotenberg, permission checks,
issuance, embedding verification and artifact persistence.

Input country codes and VAT prefixes use the pinned EN16931 code lists; national
VAT identity checks remain caller-owned. The generated gross total and amount due are capped at
`9999999999.99` EUR to stay within the independently tested output range.
`calculate` retains its larger exact-decimal range. Tax-group errors identify
indices and fields; missing groups use `totals.taxGroups`.

The repository's `bun run test:finance-conformance` executes official CII
Schematron using pinned Saxon-HE, independent decimal checks, and XSDs. This does
not add runtime Schematron to `validateInvoiceXml`. Keep Cloud's runtime XSD and
actual embedded-XML checks during migration; CI cannot verify Gotenberg output.

VAT categories default to S. Lines and groups accept `taxExemptionReason` and
`taxExemptionReasonCode`; these are written only on the XML group and projected
onto matching lines on read. E/AE/K/G/O require a reason; S/Z forbid it. Non-S
rates and disclosed tax are zero. O is exclusive, omits XML rates and VAT IDs,
and uses `taxRate: "0"` and `vatId: ""` in the existing string API. A seller without
a VAT ID needs `seller.id`; S/Z/E/AE also require `seller.taxRegistrationId`.
AE/K require buyer VAT ID; K/G require seller VAT ID. K also needs the actual
`deliverToCountryCode` and either `serviceDate` or a nonempty `period`. A tax registration is supported only for the seller.

For §25a margin schemes use E plus VATEX-EU-F (second-hand), VATEX-EU-I (art), or
VATEX-EU-J (collectors/antiques), with the required German invoice wording. Pass
the full selling price; the module does not compute internal margin VAT. Only
one E group is allowed; conflicting line reasons/codes fail. For multiple
exemption explanations use one combined group text. See `examples/einvoice-margin.ts`.
`calculate` allows missing reasons; the complete invoice must supply them on
lines or declared tax groups before `validate`/`serialize`.

## Independent incoming invoices

Use `einvoice.parseXml(xml, { mode: "incoming" })` or the same mode on
`parsePdf`. The overload returns `ParsedIncomingInvoice` with a separate
`IncomingInvoice` model, `format: "cii-en16931"`, original XML, profile and
`unmapped` supplementary XML fields with namespace-aware paths. Existing calls
without a mode keep returning the strict generation model.

Incoming reading supports the EN16931 guideline and exact CII XRechnung 3.0/2.3
identifiers. It preserves optional dates/references/identities, all payment means,
currencies, signed decimal strings, price bases, periods, adjustments and
prepayments as declared data. O line rates remain absent; no missing values or
arithmetic are invented. Review `unmapped` before accounting; original XML is the
complete source. Do not cast this model to `Invoice` for reserialization.

`validateInvoiceXml(xml, { format: "zugferd-2.5-en16931", mode: "incoming" })`
permits those CIUS identifiers against the pinned XSD only. Parsing and XSD do
not establish full EN16931/national CIUS conformance. The external regression
command `bun run test:einvoice-external` checks 11 unchanged, hash-pinned public
invoices, exact extracted values, XSD and official EN16931 core Schematron.

## Payment, periods and references in 0.27.0

`payment` and `serviceDate` are optional, also in default XML/PDF parse results.
Guard their presence when migrating. Legacy payment objects still default to
58 and retain their XML bytes. The reader returns an explicit `typeCode`.
30/58 require a valid IBAN even without an XML account container; `accountName`
is optional. Codes 10 (cash), 68 (online service) and 97 (mutual clearing) take
optional `information`, but no bank details in this writer. Do not interpret 97
as a paid flag. Absent payment emits no PaymentMeans; `{}` is invalid.

`period: { startDate?, endDate? }` requires at least one real date and end >= start.
It may replace or accompany `serviceDate`; K requires one of these delivery fields.
`precedingInvoice` is allowed on all supported kinds and required on creditNote
and selfBillingCreditNote.
Its number must be nonempty and its date must not follow the current invoice.
Use 380 with reference for additional amounts, 381 with positive amounts for
reductions, 389 with reference for additional self-billed amounts, and
`selfBillingCreditNote` (261) for buyer-issued reductions. Update exhaustive kind
switches. Replacement-invoice (384) semantics are not introduced.
See `examples/einvoice-options.ts` and the migration section in `docs/einvoice.md`.
