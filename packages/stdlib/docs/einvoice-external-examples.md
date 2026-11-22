# Reading independent CII examples

Checked on 23 September 2026 against the prepared stdlib 0.26.0 working tree.
**All 11 selected original invoices pass incoming extraction, value assertions,
the pinned XSD and official EN16931 CII Schematron 1.3.16.**

The initial strict reader failed all eight original category examples. The
additive `mode: "incoming"` overload now returns a broader, separate model;
existing default calls retain their original contract. See the
[incoming reader guide](./einvoice.md#read-xml-or-pdf).

## Reproduce the check

```sh
bun run test:einvoice-external
```

Requires Java 11+ and network access on the first run. CI runs this command.
It downloads unchanged source XML and the same pinned Saxon/Schematron artifacts
as `test:finance-conformance`. Every download and cached file is checked against
SHA-256. Source URLs contain immutable Git commits; hashes and categories are in
[the source manifest](../scripts/einvoice-external-sources.json).

No stdlib serialization, normalization, field removal or profile replacement
occurs before validation or reading. Golden extracted values were obtained
independently using Python ElementTree and are stored in
[the expected-value fixture](../scripts/einvoice-external-expected.json).
Assertions cover every line's ID, quantity, unit, price, price basis, amount,
category and rate; every group's category, rate, reason, code and amounts;
document type, number, currency, payment codes and declared totals. They also
check the unchanged XML and propagation of group reasons to matching lines.

The command exits 1 on any extraction, assertion, XSD or Schematron failure.
Download, integrity, engine and report errors fail the command too. Original
third-party files remain in the operating system's temporary cache.

## Results on original bytes

Every row passed extraction, expected values, XSD and EN16931 core Schematron.
Supplementary fields outside the typed projection remain in `unmapped`, with
their XML path, namespace and subtree; they are not silently discarded.

| Original source | VAT categories | Covered incoming variants |
|---|---|---|
| [standard-S](https://raw.githubusercontent.com/ConnectingEurope/eInvoicing-EN16931/a519ba02a59e2775436428f57ee96899feb1da8c/cii/examples/CII_example1.xml) | S | Two payment means; 20 lines; two VAT rates |
| [mixed-S-E](https://raw.githubusercontent.com/ConnectingEurope/eInvoicing-EN16931/a519ba02a59e2775436428f57ee96899feb1da8c/cii/examples/CII_business_example_01.xml) | E, S | NOK; signed lines; adjustments; prepayment; supplementary attachment |
| [outside-scope-O](https://raw.githubusercontent.com/ConnectingEurope/eInvoicing-EN16931/a519ba02a59e2775436428f57ee96899feb1da8c/cii/examples/CII_example7.xml) | O | SEK; no VAT rate or VAT total; period |
| [reverse-charge-AE](https://raw.githubusercontent.com/ZUGFeRD/mustangproject/7869b59a0ff17636355e4ed44a4518d190683155/library/src/test/resources/XRechnung_internalRecalcBug.xml) | AE | CII XRechnung 3.0; reverse charge; line period |
| [export-G](https://raw.githubusercontent.com/ZUGFeRD/mustangproject/7869b59a0ff17636355e4ed44a4518d190683155/library/src/test/resources/test_invoice_contract.xml) | G | CII XRechnung 3.0; export reason; contract reference |
| [intra-community-K](https://raw.githubusercontent.com/stephanstapel/ZUGFeRD-csharp/743807b2752636a867ee8eae7a00696d45dbf33e/documentation/zugferd240de/Beispiele/3.%20EN16931/EN16931_Innergemeinschaftliche_Lieferungen/EN16931_Innergemeinschaftliche_Lieferungen.xml) | K | Self-billing; delivery country; periods instead of delivery date |
| [exempt-E](https://raw.githubusercontent.com/stephanstapel/ZUGFeRD-csharp/743807b2752636a867ee8eae7a00696d45dbf33e/documentation/zugferd240de/Beispiele/3.%20EN16931/EN16931_Kleinunternehmer_ohne_USt_ID/EN16931_Kleinunternehmer_ohneUStId.xml) | E | No seller VAT ID; H87 unit; price basis; payment information |
| [zero-rated-Z](https://raw.githubusercontent.com/stephanstapel/ZUGFeRD-csharp/743807b2752636a867ee8eae7a00696d45dbf33e/documentation/zugferd240de/Beispiele/3.%20EN16931/EN16931_Photovoltaik/EN16931_Photovoltaik.xml) | Z | No payment means; zero rate without exemption reason |
| [price-basis-HUF](https://raw.githubusercontent.com/ConnectingEurope/eInvoicing-EN16931/a519ba02a59e2775436428f57ee96899feb1da8c/cii/examples/huf_example_cii.xml) | S | HUF; basis quantity 100 without unit attribute; decimal trailing point |
| [optional-empty-text](https://raw.githubusercontent.com/horstoeko/zugferd/b6daabd92d35357f1f6e1c0603d32c3e10dfc51f/tests/assets/xml_en16931_2.xml) | S | Optional empty buyer product IDs; all line amounts preserved |
| [xrechnung-2.3](https://raw.githubusercontent.com/ZUGFeRD/mustangproject/7869b59a0ff17636355e4ed44a4518d190683155/validator/src/test/resources/validXRV23.xml) | S | Earlier CII CIUS identifier |

## Limits of this evidence

The larger exploratory collection included 91 files with different profiles,
legacy identifiers and deliberately invalid test invoices. The 11-case permanent
suite covers the supported profiles and the observed interoperability failures;
it does not claim every file in that collection is conformant or supported.

No unchanged public F/I/J margin-scheme sample was found in that collection.
Those schemes have generated round-trip tests and official Schematron checks in
`test:finance-conformance`, with VATEX provenance in the main guide. They must
not be described as tested against independent margin-scheme invoice originals.

This run uses Saxon-HE with the official EN16931 CII XSLT, not the KoSIT or
Mustang validator application. Core Schematron plus the pinned ZUGFeRD 2.5
EN16931 XSD does not establish national XRechnung CIUS or PDF/A conformance.
Parsing alone checks core shape and selected VAT rules, not all business rules
or arithmetic. Review unmapped supplementary data before accounting and keep
the unchanged original XML as the complete source of truth.
