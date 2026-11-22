# Finance conformance and migration

The original finance audit covers version 0.25.0, checked on 15 September 2026.
The VAT category extension below requires version 0.26.0. Version 0.24.0 does not
have the header APIs or the strengthened validation from the original audit.
No Cloud files were changed.

## Explicit payment rounding extension (0.31.0)

Verified on 21 October 2026 with the pinned profile XSDs and official EN16931
CII validation 1.3.16, executed by Saxon-HE 10.9 on Java 21. The canonical
`bun run test:finance-conformance` passes **128 Schematron cases: 93 valid
invoices and 35 negative controls**, plus independent Python Decimal, SEPA,
DATEV CSV, and DATEV XML checks.

The 32 new valid cases cover signed BT-114, explicit zero, zero due, 7%/19%/20%,
mixed rates, and the 20% three-cent case with each explicitly chosen net basis.
Every case runs for 380/381/389/261, preserving required correction references.
All valid cases now also pass the strict reader, validator and byte-identical
writer roundtrip. Two new XSD-valid negative controls must fail BR-CO-16
(inconsistent due) and BR-DEC-17 (rounding scale). VAT still equals the rounded
net-group calculation; no Schematron tax tolerance is used to justify a different
VAT decomposition. The unchanged legacy XML golden remains enforced.

This verifies the core profile and exact arithmetic, not a national CIUS or tax
treatment. The caller must explicitly choose the net basis and payment adjustment.
The [public rounding contract](./einvoice.md#explicit-payment-rounding-bt-114)
describes the changed tax presentation and positive credit-note convention.
`money.taxFromGross` and incoming extraction remain unchanged. Version 0.30.0
does not include this extension; no package publication is claimed here.

## Payment, period and correction extension in 0.27.0

Verified on 29 September 2026 against the existing pinned XSD and EN16931 CII
validation 1.3.16. `bun run test:finance-conformance` passes **94 Schematron
cases: 61 valid invoices and 33 negative controls**, with independent decimal,
SEPA, and DATEV checks. The missing payment-code control also fails XSD; the
other negative controls remain XSD-valid. The 11 unchanged public incoming
examples pass extraction, XSD, and their expected core Schematron assertions.
No KoSIT or Mustang wrapper or national CIUS validation was run.

New cases cover every payment code (10/30/58/68/97) and omitted payment for
invoice, creditNote, selfBilling, and selfBillingCreditNote (261). They also
cover period-only delivery, either period endpoint, references on additional
invoices/self-billing, and payment-free reductions. Negative controls exercise
BR-49, BR-61, BR-CL-16, BR-29, BR-CO-19, BR-55, and BR-IC-11. Unit tests enforce
missing transfer accounts locally, since the pinned BR-50/61 expressions only
run in an account-element context. A SHA-256 regression preserves the exact
legacy example XML bytes.

See [payment, period and type migration](./einvoice.md#payment-instructions-periods-and-corrections-0270)
for optional return fields and the new document kind. Consumer upgrades must account for these type changes and remain separate
from the stdlib release.

## VAT category extension in 0.26.0

Verified on 23 September 2026 with the same pinned ZUGFeRD 2.5 XSDs and official
EN16931 CII validation 1.3.16, executed by Saxon-HE 10.9 on Java 21. The local
`bun run test:finance-conformance` passes 52 Schematron cases: 26 valid invoices
and 26 XSD-valid negative controls, plus independent Python decimal, SEPA, and
DATEV checks. No KoSIT or Mustang application wrapper was run; this directly
executes the official EN16931 core rules, without claiming XRechnung CIUS
validation.

New positive cases cover Z/E/AE/K/G/O, all three F/I/J margin-scheme codes,
S+E, separate zero-rate categories, text-only reasons, and a seller identified
without a VAT ID. New negative controls cover the BR-E/Z/O/AE/IC/G taxable-basis,
tax-amount and reason rules, missing AE/K buyer VAT IDs, missing K delivery
country, and an O line with a VAT rate. The decimal checker groups independently
by category and rate, treating absent O XML rates as zero.

The API keeps existing string fields: absent VAT IDs are represented by `""`;
O uses `taxRate: "0"` but emits no XML rate. The new optional fields and the
example for §25a are documented in [the E-Invoice guide](./einvoice.md). S input
without category fields retains its existing behavior and generated XML.

The [test with independent original invoices](./einvoice-external-examples.md)
now checks **11 unchanged public examples** using `mode: "incoming"`. It asserts
extracted values and runs XSD plus official EN16931 core Schematron in CI. The
default reader retains the narrower generation contract.

## Generator contract

Within the documented subset, `validate` checks input shape, field combinations,
and supported business consistency. `serialize` repeats the same checks and
returns deterministic bytes for the same values and row order. Callers provide
all dates, IDs, and configuration. Generators do not read the clock, contact
services, mutate global decimal settings, or infer business identities.

| Format | Production guarantees | Independent evidence | Deliberate limits |
|---|---|---|---|
| E-Invoice | Exact decimal line/VAT calculation; supplied sums and tax groups must agree; CII escaping; required references and fields; code lists | Pinned profile XSD; official EN16931 CII Schematron; Python decimal checks and negative controls | EUR, positive invoice/credit-note/self-billing model, VAT categories S/Z/E/AE/K/G/O, four units, gross and due at most 9999999999.99 |
| DATEV | Strict 700/13 fields, period/row-date/account relationships, exact totals, BOM/CSV layout | Official sample column fingerprint; reviewed golden bytes; independent Python CSV parser and field assertions | EUR, supported columns only; no tax-key meaning or bookkeeping balance inference |
| SEPA | DK GBIC 5 SCT fields/repertoire, checked IBAN/BIC, unique per-file end-to-end IDs, exact count and control sums | Official DK XSD plus independently parsed SCT profile/count/sum assertions | One debtor/date/block; no addresses, instant transfers or direct debits; no bank acceptance guarantee |
| CAMT | Bounded namespace-aware parser preserving decimal strings and original XML tree | Existing pinned ISO XSD and public MNB fixtures | camt.052.001.08 only; no accounting reconciliation |

Header validators cover configuration only, without rows, `createdAt`, or SEPA
message/payment-information IDs. Full batch validation adds runtime metadata,
nonempty rows, and cross-row checks. Field errors use zero-based paths. Input
checks are not a replacement for application authorization or finalization.

Readers preserve declared incoming values. A parsed invoice may have inconsistent
sums: `einvoice.validate(parsed.invoice)` checks them without reserializing.
Public XML validators remain independent XSD-only checks; the schemas support
more than the intentionally narrow readers/writers.

## Findings resolved

- `einvoice.validate` previously accepted sums that `serialize` rejected. Both
  now use the same preparation and consistency checks.
- Tax-group errors now identify the individual group and amount/rate field.
- Country codes and VAT country prefixes previously accepted invalid values
  such as `ZZ`. Checks now use the pinned EN16931 code list. National VAT
  registration validity is not inferred. The list entry `1A` is accepted for
  both addresses and VAT prefixes.
- Dates no longer accept year zero for generated invoices.
- The official rules rejected a previously tested extreme value above JavaScript
  number precision (`9007199254740993.0050`, BR-CO-10). The exact calculator remains
  unchanged; validation/generation now enforce a conservative, independently
  tested gross limit. This is a library limit, not a standard-mandated maximum.
- SEPA previously allowed all XML text, exceeding the DK repertoire. Unsupported
  characters and whitespace-only names/remittance/IDs now fail explicitly.
- DATEV and SEPA expose header checks using the same schemas as full batches.

## Run independent checks

```sh
bun test src/finance
bun run test:finance-conformance
```

The second command requires Java 11+ and Python 3. It downloads two pinned
artifacts into the system temporary directory, checks SHA-256 before using cached
or downloaded bytes, and fails on download, integrity, engine, or assertion
errors. It never silently skips conformance checks. Generated case files are
temporary. No new npm runtime dependency is added.

Saxon executes the official precompiled XSLT; stdlib does not implement a
Schematron engine. Positive cases must have no failed assertions, including
warnings. XSD-valid negative controls must produce failures for their expected rule IDs. Python
independently parses CII/SEPA XML and DATEV CSV and calculates with `Decimal`.
The same command is required in CI before tag publication. CI also typechecks
all scripts and examples with `bunx tsc -p tsconfig.scripts.json`.

Sources and pins:

- [EN16931 validation 1.3.16](https://github.com/ConnectingEurope/eInvoicing-EN16931/releases/tag/validation-1.3.16):
  `cii/xslt/EN16931-CII-validation.xslt`, SHA-256
  `0b234dea2bbfee739b7761e607a992c17fab88773014ef56355b6158cfb1cc53`.
  Upstream license: EUPL 1.2; downloaded for development, not bundled in npm.
- [Saxon-HE 10.9](https://repo.maven.apache.org/maven2/net/sf/saxon/Saxon-HE/10.9/):
  SHA-256 `491d8edf4ec811d15c2b2417b007218b9b938f15e4dfbad004025beb4e70e960`.
  Upstream license: MPL 2.0; standalone development tool.
- [DK Appendix 3 v3.9](https://www.ebics.de/de/datenformate/gueltige-version),
  section 2.1 (pages 82–84: counts, sums, repertoire), and section 2.2.1 (SCT).
  [DK GBIC 5 schema](https://www.ebics.de/de/datenformate/ergaenzende-dokumente)
  remains pinned as documented in the finance guide.
- [DATEV format reference](https://developer.datev.de/de/file-format/details/datev-format/getting-started)
  and its public sample archive `Musterdaten_DATEV_Format_0_7f9322b9cc.zip`.
  The 125 headings in `EXTF_Buchungsstapel.csv` match the writer exactly; their
  UTF-8 semicolon-joined SHA-256 is
  `098f89c80237a74bfa03dd3e1f4bb5cf2ecc8157fb4ee373626bdd70a0966cf7`.
  Our golden uses synthetic example data. DATEV's Windows checking program and
  a real accounting import were not executed.

The E-Invoice suite checks the existing ZUGFeRD 2.5 profile XSD plus EN16931 core
rules, not every rule of later ZUGFeRD releases or national CIUS profiles.
[FeRD's current release](https://www.ferd-net.de/en/downloads/publications/details/zugferd-252-english)
is 2.5.2; this work does not silently change the existing format identifier.

## Cloud replacement contract

The conformance matrix also covers absent/empty seller and buyer address line 1
(BT-35/BT-50), separately and together, with swapped parties across all four
document kinds. Each case passes the pinned XSD and EN16931 validation 1.3.16
Schematron and a strict XML round trip. Unit tests additionally cover PDF
attachments and compare existing XML bytes against a 0.31.1 fixture.

1. After an approved stdlib release, upgrade Cloud's dependency. Until then,
   do not call the new header APIs from an installed 0.24.0 consumer.
2. Project workflow configuration onto `DatevHeader` / `SepaHeader` and call
   `validateHeader`. Remove dummy rows/IDs and duplicate format refinements.
   Retain application transport schemas and translate issue paths for the UI.
3. Assemble real rows, timestamps, and IDs at execution; call full validation or
   serialization again. Early header success does not authorize execution.
4. Replace invoice arithmetic, XML generation and supported XML/PDF reading with
   stdlib. Use `einvoice.validate` to compare supplied amounts. Preserve existing
   snapshot mappings and historical artifacts. The local migration patch remains
   under ignored `migration/`; refresh it against the current Cloud checkout.
5. Keep numbering, permissions, agreement/original-invoice identity checks,
   correction budgets, duplicate claims, finalization, audit, storage, and payment
   state in Grids. Keep HTML/PDF rendering and verification of the actual XML
   embedded by Gotenberg there as well.

During migration, preserve Cloud's existing runtime XSD checks. Independent CI
makes duplicate checking of pristine serializer bytes a possible later
optimization, but that needs an explicit caller decision and evidence for its
actual pipeline. External or transformed XML still needs its own checks. None of
these changes certify PDF/A or the agreement between visible PDF and XML.

## Format priorities

1. Correctness within the current subset and header validation are implemented
   here. No new format family is necessary for those changes.
2. Next useful E-Invoice extensions should follow actual rejected documents:
   generation of other units, discounts, and prepayments still needs explicit
   calculation contracts. Incoming extraction supports their declared data.
3. Add camt.053/.054 or other .052 versions only against real bank examples and
   their versioned schemas. A namespace rename is not an implementation.
4. UBL, more ZUGFeRD profiles, SEPA addresses/instant/direct debit,
   additional DATEV categories and PDF/A generation are separate product slices.
   No bookkeeping framework or automatic banking actions are introduced.

## Beleglink and file-only DATEV documents (0.36.0)

Focused tests pin column 20 to the documented raw cell `"BEDI ""<GUID>"""`,
leave omitted links empty, reject malformed/braced GUIDs and preserve case.
Image-only and mixed image/ledger packages pass the pinned official DATEV XSDs;
tests check ZIP contents, missing GUID rejection and the shared CSV/XML ID.
The existing ledger XML goldens and ZIP SHA-256 remain unchanged. These checks
prove technical conformance, not import behavior or the expected "Sonstige
Belege" filing label; see [the assumptions](./datev-xml.md#transfer-images-and-link-monthly-bookings).

**Release verification note:** Ein Testimport in DATEV ist hier nicht möglich; die Kanzlei muss einmal Testimport plus Beleglink prüfen.
