---
id: grids-financial-formats
title: Financial file formats
icon: ti ti-file-invoice
description: Look up the supported E-Invoice, DATEV, and SEPA inputs, their limits, validation, and safe export boundaries.
order: 136
---
Grids supports a defined subset of financial formats. Choose a format that the recipient supports. Then test a representative file with the recipient's import settings.

:::warning A valid file is not a transfer
Generating or validating a file does not transfer money, does not import bookkeeping, and does not certify legal correctness.
:::

## Choose a format {icon="file-description"}

| Grids output | Supported format | What it produces |
| --- | --- | --- |
| E-Invoice renderer `de.zugferd.en16931`, versions 1 and 2 | ZUGFeRD 2.5 / Factur-X 1.09 EN 16931, CII | PDF with embedded `factur-x.xml` plus the separate XML |
| `datev-csv`, version 1 | DATEV 700/13, EUR | UTF-8 CSV with BOM; filename `EXTF_*.csv` |
| `sepa-xml`, version 1 | SCT `pain.001.001.09`, DK GBIC 5, EUR | One XML file with one or more transfers |

## Prepare E-Invoice input {icon="file-invoice"}

Run `cld grids documents renderers --json` to choose the installed renderer. Its `inputSchema` is the structural contract. The Liquid JSON of a template maps the selected record into that input. Preview it before you enable the template.

:::reference
- **Required in both versions:** `invoiceDate`, `dueDate`, `currency: "EUR"`, `seller`, `buyer`, `buyerReference`, `payment`, and `lines`.
- **Parties:** `name`, a German `vatId`, and `address: {line1, city, postalCode, countryCode:"DE"}`.
- **Payment:** `iban` and `accountName`.
- **Dates:** Real ISO calendar dates. The due date cannot be before the invoice date.
- **Lines:** 1–1,000 lines. Each line has `name`, a positive `quantity` with four decimal places, a nonnegative `unitPrice` with four decimal places, and a positive `taxRate` with two decimal places, at most 100.
:::

Pass decimal strings, not floating-point numbers. Line net amounts round half-up to cents. Tax rounds per tax-rate group. PDF and XML use the same calculated totals.

Version 2 also requires `serviceDate` and `billing`:

- `{kind:"invoice"}`;
- `{kind:"creditNote", original:{number, invoiceDate}, reason}`;
- `{kind:"selfBilling", agreementReference}`.

Lines in version 2 can have `description` and `unitCode`: `C62` (default), `HUR`, `DAY`, or `KGM`. Quantities and amounts stay positive. The document kind carries the meaning. In self-billing, the seller stays the supplier and the buyer stays the customer. You must state the receiving bank account explicitly. Grids does not infer it.

These Grids profiles are narrower than an arbitrary invoice model. They do not support zero-rated or exempt VAT, allowances, charges, prepayments, imports of incoming invoices, or arbitrary XML formats. Workflows check whether the original exists and whether correction or commission budgets remain. The serializers do not check this. The Billing template adds business rules. Choosing this renderer alone does not add them.

## Prepare SEPA transfer input {icon="transfer"}

The workflow `output` has `kind: sepa-xml`, `version: 1`, `header`, and `mapping`. [Workflows](/app/grids/help/grids-workflows) shows executable query and mapping examples.

:::reference
- **Header:** `destinationKey`, `debtorName` (1–70 characters), `debtorIban`, `executionDate` (ISO date), and an optional `debtorBic`.
- **Required mappings:** `businessId`, `endToEndId`, `amount`, `creditorName`, `creditorIban`, and `remittance`.
- **Optional mapping:** `creditorBic`.
:::

Mapping values are exact selected column aliases, not expressions or raw cell values. Each value must meet these rules:

- The amount is positive with exactly two decimal places, at most `999999999.99`. Grids does not round fractions of a cent.
- The IBAN is a valid uppercase electronic SEPA IBAN, without spaces and not a QR-IBAN. A BIC, when supplied, must be valid.
- The creditor name has up to 70 characters. The remittance has up to 140.
- Names and remittance allow A–Z/a–z, digits, spaces, `+ ? / : ( ) . , ' -`, and `& * $ % Ä Ö Ü ä ö ü ß`. Grids rejects other characters, including `é` and `€`. It does not rewrite them.
- `endToEndId` is not blank and has at most 35 basic SEPA characters, without the German extensions. It has no leading or trailing slash and no `//`. It is unique within the batch.
- Grids creates one transfer for each unique `businessId`. Grids creates and keeps the message and payment-information IDs.
- A past execution date produces a warning. Grids does not replace it with today's date.

This output is SCT. It is not a direct debit and not an instant-payment product. The receiving bank decides whether it accepts the file.

## Prepare DATEV posting input {icon="receipt"}

The header has `destinationKey`, `consultantNumber`, `clientNumber`, `fiscalYearStart`, `accountLength`, `periodStart`, `periodEnd`, `label`, and `finalize`:

- The consultant number is a string of 4–7 digits, at least 1001. The client number is a string of 1–5 digits whose first digit is not zero.
- Dates are in 2000–2099. The posting period must be in order and inside one fiscal year.
- The account length is an integer from 4 to 8. The label has 1–30 letters, digits, underscores, dots, dashes, slashes, or spaces.
- `finalize` controls the finalization of the DATEV import, not the finalization of Grids records.

Required mappings are `businessId`, `entryId`, `amount`, `direction`, `account`, `counterAccount`, `documentDate`, and `documentNumber`. Optional mappings are `text`, `taxKey`, `costCenter1`, and `costCenter2`:

- The amount is positive with two decimal places, up to `9999999999.99`. The direction is `S` or `H`. Do not use negative money.
- Accounts are digit strings other than zero, with at most 9 digits and at most `accountLength + 1`.
- The document date is inside the posting period. The document number has 1–36 ASCII letters, digits, or `_ $ & % * + - /`, and no spaces.
- The text has up to 60 characters without control characters. The tax key has exactly four digits.
- Cost centers have up to 36 letters, digits, underscores, or spaces.
- Several postings can share a business event, but each `entryId` within that event must be unique.

This output is a booking batch, not the complete DATEV product family. ADDISON or other software can need a specific import configuration.

## Review once and keep identities {icon="check"}

Both financial workflow outputs accept 1–10,000 rows within the cumulative capture budget. `destinationKey`, `businessId`, and the DATEV `entryId` have 1–200 characters without surrounding whitespace or control characters. They identify the real destination and the business event. They do not identify a run, a filename, or a newly generated random value.

A manual run pauses for review. Confirm the exact preview hash before issuance. Scheduled and record-triggered financial exports are not supported. If you cancel before issuance, Grids reserves nothing for the duplicate-export check. A successful issuance stores the document and its export reservations atomically. A retry reuses the same reviewed receipt.

:::danger Do not evade the duplicate check
Never change identities to get past a duplicate-export check.
:::

At runtime, Grids validates the input semantically and validates generated E-Invoice and SEPA XML against a pinned XSD. After external PDF rendering, Grids reads the embedded XML and compares it. XSD and embedding checks are not full Schematron, not PDF/A certification, not tax advice, and not a bank acceptance test.

Related: [Documents & PDFs](/app/grids/help/grids-documents-pdfs), [Billing template](/app/grids/help/grids-build-business-app).
