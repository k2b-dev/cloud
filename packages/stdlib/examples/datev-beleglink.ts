import { datev, type DatevBatch, type DatevXmlPackage } from "../src/finance";
import { createDatevXmlPackage, type DatevXmlSchemas } from "../src/finance/validate";
import { datevExample } from "./finance";

/** Persist the GUID with the image; reuse it in every matching monthly booking row. */
export async function datevBeleglinkExample(receiptBytes: Uint8Array, schemas: DatevXmlSchemas) {
  const guid = "E0A08953-FBAA-4054-AF36-993D5D68F040";
  const images: DatevXmlPackage = {
    format: "datev-xml-online-6.0", currency: "EUR", createdAt: "2026-10-01T09:15:00",
    generatorInfo: "Example company",
    documents: [{ kind: "documentImage", guid, files: [{ name: "RE-2026-1.pdf", bytes: receiptBytes }] }],
  };
  const bookings: DatevBatch = {
    ...datevExample,
    rows: [{ ...datevExample.rows[0]!, documentGuid: guid }],
  };
  const zip = await createDatevXmlPackage(images, { schemas });
  if (!zip.ok) return zip;
  const csv = datev.serialize(bookings);
  if (!csv.ok) return csv;
  return { ok: true as const, data: { imageZip: zip.data.bytes, bookingCsv: csv.data.bytes } };
}
