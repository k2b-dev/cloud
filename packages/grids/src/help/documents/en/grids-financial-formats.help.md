---
id: grids-financial-formats
title: Financial file formats
icon: ti ti-file-invoice
description: Supported E-Invoice, DATEV and SEPA inputs, limits, validation and safe export boundaries.
order: 136
---
Grids offers a defined subset of financial formats. Choose a format supported by the recipient, then test a representative file with that recipient's import settings. Generating or validating a file does not transfer money, import bookkeeping, or certify legal correctness.

## Formats and ownership {icon="file-description"}

| Grids output | Supported format | What it produces |
| --- | --- | --- |
| E-Invoice renderer `de.zugferd.en16931`, versions 1 and 2 | ZUGFeRD 2.5 / Factur-X 1.09 EN 16931, CII | PDF with embedded `factur-x.xml` plus the separate XML |
| `datev-csv`, version 1 | DATEV 700/13, EUR | UTF-8 CSV with BOM; filename `EXTF_*.csv` |
| `sepa-xml`, version 1 | SCT `pain.001.001.09`, DK GBIC 5, EUR | One XML file containing one or more transfers |


## E-Invoice input {icon="file-invoice"}

Choose the installed renderer with `cld grids documents renderers --json`; its `inputSchema` is the structural contract. A template's Liquid JSON maps the selected Record into that input. Preview it before enabling the template.

Both versions require `invoiceDate`, `dueDate`, `currency: "EUR"`, `seller`, `buyer`, `buyerReference`, `payment` and `lines`. Parties have `name`, German `vatId`, and `address: {line1, city, postalCode, countryCode:"DE"}`. Payment has `iban` and `accountName`. Dates are real ISO calendar dates; due date cannot precede invoice date.

Each of 1–1,000 lines has `name`, positive `quantity` with four decimal places, nonnegative `unitPrice` with four decimal places, and positive `taxRate` with two decimal places, at most 100. Pass decimal strings, not floating-point numbers. Line nets round half-up to cents; tax rounds per tax-rate group. PDF and XML use the same calculated totals.

Version 2 additionally requires `serviceDate` and `billing`:

- `{kind:"invoice"}`;
- `{kind:"creditNote", original:{number, invoiceDate}, reason}`;
- `{kind:"selfBilling", agreementReference}`.

Version 2 lines may have `description` and `unitCode`: `C62` (default), `HUR`, `DAY`, or `KGM`. Quantities and amounts stay positive; the document kind carries the meaning. Seller remains supplier and buyer remains customer in self-billing. The receiving bank account is explicit, not inferred.

These Grids profiles are narrower than an arbitrary invoice model: no zero/exempt VAT, allowances, charges, prepayments, incoming invoice import, or arbitrary XML formats. Workflows, not serializers, check whether the original exists and correction/commission budgets remain available. The Billing template adds business rules; choosing this renderer alone does not add them.

## SEPA transfer input {icon="transfer"}

The workflow's `output` has `kind: sepa-xml`, `version: 1`, `header`, and `mapping`. See [Workflows](/app/grids/help/grids-workflows) for executable query/mapping examples.

Header: `destinationKey`, `debtorName` (1–70 characters), `debtorIban`, `executionDate` (ISO date), optional `debtorBic`.

Required mappings: `businessId`, `endToEndId`, `amount`, `creditorName`, `creditorIban`, `remittance`; optional `creditorBic`. Mapping values are exact selected column aliases, not expressions or raw cell values.

- Positive amount with exactly two decimal places, at most `999999999.99`; no fractional-cent rounding.
- Valid uppercase electronic SEPA IBAN, no spaces or QR-IBAN. A BIC, when supplied, must be valid.
- Creditor name up to 70 characters; remittance up to 140.
- Names/remittance allow A–Z/a–z, digits, spaces, `+ ? / : ( ) . , ' -` and `& * $ % Ä Ö Ü ä ö ü ß`. Other characters, including `é` and `€`, are rejected, not rewritten.
- `endToEndId`: nonblank, at most 35 basic SEPA characters (without the German extensions), no leading/trailing slash or `//`; unique within the batch.
- One transfer per unique `businessId`. Grids creates and retains message/payment-information IDs.
- Past execution dates produce a warning; Grids does not replace them with today's date.

This output is SCT, not direct debit or an instant-payment product. The receiving bank determines file acceptance.

## DATEV posting input {icon="receipt"}

Header: `destinationKey`, `consultantNumber`, `clientNumber`, `fiscalYearStart`, `accountLength`, `periodStart`, `periodEnd`, `label`, and `finalize`.

- Consultant number: 4–7 digit string, at least 1001. Client: 1–5 digit string with nonzero first digit.
- Dates are in 2000–2099. Posting period must be ordered and within one fiscal year.
- Account length: integer 4–8. Label: 1–30 letters/digits, underscore, dot, dash, slash, or spaces.
- `finalize` controls DATEV import finalization, not Grids Record finalization.

Required mappings: `businessId`, `entryId`, `amount`, `direction`, `account`, `counterAccount`, `documentDate`, `documentNumber`. Optional: `text`, `taxKey`, `costCenter1`, `costCenter2`.

- Positive two-decimal amount up to `9999999999.99`; direction `S` or `H`, not negative money.
- Accounts: nonzero digit strings, at most 9 digits and `accountLength + 1`.
- Document date inside the posting period. Document number: 1–36 ASCII letters/digits or `_ $ & % * + - /`, no spaces.
- Text up to 60 characters without controls; tax key exactly four digits.
- Cost centers up to 36 letters/digits, underscore or spaces.
- Several postings may share a business event, but each `entryId` within it must be unique.

This is a booking batch, not the complete DATEV product family. ADDISON or other software may need a specific import configuration.

## Review once, preserve identities {icon="check"}

Both financial workflow outputs accept 1–10,000 rows under the cumulative capture budget. `destinationKey`, `businessId` and DATEV `entryId` are 1–200 characters without surrounding whitespace or control characters. They identify the real destination and business event, not a run, filename, or newly generated random value.

A manual run pauses for review. Confirm the exact preview hash before issuance. Scheduled and record-triggered financial exports are not supported. Cancelling before issuance creates no export claim; successful issuance atomically stores the Document and its claims. Retrying reuses the same reviewed receipt. Never change identities to evade a duplicate-export check.

Runtime checks include semantic input validation and pinned XSD validation for generated E-Invoice/SEPA XML. After external PDF rendering, Grids reads and compares the embedded XML. XSD and embedding checks are not full Schematron, PDF/A certification, tax advice or a bank acceptance test.

Related: [Document lifecycle](/app/grids/help/grids-documents-pdfs), [Billing template](/app/grids/help/grids-build-business-app).
