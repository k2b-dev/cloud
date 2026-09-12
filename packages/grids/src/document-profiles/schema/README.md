# Pinned SEPA schema

`pain.001.001.09_GBIC_5.xsd` is the Deutsche Kreditwirtschaft technical
validation subset for SCT/SCT Inst under Anlage 3 version 3.9. Grids generates
ordinary EUR SCT only; the schema's support for other cases does not enable them.

Source: [DK supplementary documents](https://www.ebics.de/de/datenformate/ergaenzende-dokumente),
archive `DK-TVS_SEPA_GBIC_5zzglISO_Originale.zip`, retrieved 11 September 2026.
The published schema header is dated 1 April 2025. Its original comments and
annotations are retained; line endings are normalized to LF.

Checked-in SHA-256:
`35cfe972a636392704fd930c3e0496fc05b95ff891deb635b168dcdabf3c08a3`.

Validation is local with `libxml2-wasm@0.6.0`, without network access, external
entities or downloaded schemas. Schema validity does not guarantee a bank will
accept the file, validate an account's owner, or execute a payment.
