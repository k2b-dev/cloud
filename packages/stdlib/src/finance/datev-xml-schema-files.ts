// DATEV XML-Schnittstelle online 6.0. The XSDs are DATEV's and are not shipped with
// this package; callers supply them and every check verifies these pinned hashes.

/** Where the schema files come from. The archive also contains invoice XSDs, which are not used. */
export const datevXmlSchemaSource = {
  version: "6.0",
  url: "https://developer.datev.de/assets/XSD_3c866dbe96.zip",
  archiveSha256: "0b25a3e512a262c93142d977b88bc04d1169e1495ebf72069cb074d6c4c42cb0",
} as const;

/** SHA-256 of the UTF-8 bytes of each required schema file, keyed by its file name in the archive. */
export const datevXmlSchemaSha256 = {
  "Document_v060.xsd": "11759fba36a156719e7cc3c1e19708aa0ea885e9093b6bdbb6a495c40bff362a",
  "Document_types_v060.xsd": "78ee3cb0f05aa93652347cd5693184b16ab52985b83e1270234448db68327022",
  "Belegverwaltung_online_ledger_import_v060.xsd": "b2807c9ef14c87dea214bda5c3b2cf2de8333511897eb51dbf19b526409f62be",
  "Belegverwaltung_online_ledger_types_v060.xsd": "a2bc696b0dbf18b49943001a06e6268f0480aaaa8bf272964972b524ec2542a3",
} as const;

export type DatevXmlSchemaFile = keyof typeof datevXmlSchemaSha256;
/** Schema file name → XSD text, exactly as in DATEV's archive (UTF-8, CRLF). Extra entries are ignored. */
export type DatevXmlSchemas = Readonly<Record<string, string>>;
