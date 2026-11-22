import { datevXml, type DatevXmlPackage } from "../src/finance";

/** A tiny placeholder PDF; real applications pass the stored document image. */
export const samplePdf = (label: string) => new TextEncoder().encode(
  `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n% ${label}\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
);

/** Sample identifiers, accounts and IBANs illustrate syntax only; do not upload this package. */
export const datevXmlExample: DatevXmlPackage = {
  format: "datev-xml-online-6.0",
  currency: "EUR",
  createdAt: "2026-11-02T09:15:00",
  generatorInfo: "Muster GmbH",
  generatingSystem: "Example Software",
  description: "Belege Oktober 2026",
  documents: [
    {
      kind: "accountsPayableLedger",
      guid: "0f8fad5b-d9cb-469f-a165-70867728950e",
      period: "2026-10",
      folder: "Eingangsrechnungen",
      documentDate: "2026-10-14",
      documentNumber: "R-2026-0815",
      deliveryDate: "2026-10-10",
      dueDate: "2026-10-28",
      partyName: "Bürobedarf Müller & Söhne",
      partyCity: "Nürnberg",
      iban: "DE89370400440532013000",
      lines: [
        { amount: "119.00", taxRate: "19.00", costCenter1: "100", text: "Büromaterial 19 %" },
        { amount: "10.70", taxRate: "7.00", costCenter1: "100", text: "Fachbuch 7 %" },
      ],
      files: [{ name: "ER-R-2026-0815.pdf", bytes: samplePdf("incoming invoice") }],
    },
    {
      kind: "accountsReceivableLedger",
      period: "2026-10",
      folder: "Ausgangsrechnungen",
      documentDate: "2026-10-20",
      documentNumber: "RE2026-00012",
      partyName: "Erika Mustermann",
      partyCity: "Köln",
      lines: [{ amount: "-50.00", taxRate: "19.00", text: "Gutschrift Versand" }],
      files: [{ name: "RE2026-00012.pdf", bytes: samplePdf("credit note") }],
    },
    {
      kind: "cashLedger",
      period: "2026-10",
      cashRegister: { name: "Kasse" },
      documentDate: "2026-10-21",
      lines: [
        { amount: "-23.80", taxRate: "19.00", text: "Porto", documentNumber: "KB-0042", information: "Kassenbon Deutsche Post" },
      ],
      files: [{ name: "KB-0042.pdf", bytes: samplePdf("cash receipt") }],
    },
  ],
};

export function datevXmlPackageExample() {
  const file = datevXml.serialize(datevXmlExample);
  if (!file.ok) throw new Error(JSON.stringify(file.error));
  return { zipBytes: file.data.bytes.byteLength, documents: file.data.documents.map(document => [document.dataFile, document.amount]) };
}
