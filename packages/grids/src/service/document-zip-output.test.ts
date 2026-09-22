import { describe, expect, test } from "bun:test";
import type { DocumentArtifact } from "../contracts";
import { DocumentZipOutputSchema, planZipEntries } from "./document-zip-output";

const artifact = (key: string, filename: string, mimeType = "application/pdf"): DocumentArtifact => ({
  key,
  fileId: Bun.randomUUIDv7(),
  filename,
  mimeType,
  sizeBytes: 42,
  sha256: "a".repeat(64),
});

describe("ZIP output schema", () => {
  test("applies defaults and requires a selection", () => {
    const parsed = DocumentZipOutputSchema.parse({ kind: "zip", files: [{ column: "Invoice" }] });
    expect(parsed).toEqual({ kind: "zip", files: [{ column: "Invoice", required: true }], include: [] });
    expect(DocumentZipOutputSchema.safeParse({ kind: "zip" }).success).toBe(false);
    expect(DocumentZipOutputSchema.safeParse({ kind: "zip", include: ["report"] }).success).toBe(true);
    for (const folder of ["..", "a/b", "a\\b", "x\u0000y", ""]) {
      expect(DocumentZipOutputSchema.safeParse({ kind: "zip", files: [{ folder }] }).success, folder).toBe(false);
    }
    expect(DocumentZipOutputSchema.safeParse({ kind: "zip", files: [{ mediaType: "not a type" }] }).success).toBe(false);
  });
});

describe("planZipEntries", () => {
  test("keeps selection order, drops repeated Document artifacts and disambiguates equal names", () => {
    const a = { id: Bun.randomUUIDv7(), shortId: "DOC00A", tableId: null, artifacts: [] };
    const b = { id: Bun.randomUUIDv7(), shortId: "DOC00B", tableId: null, artifacts: [] };
    const aPdf = artifact("pdf", "Invoice.pdf");
    const bPdf = artifact("pdf", "Invoice.pdf");
    const bXml = artifact("xml", "Invoice.pdf", "application/xml");
    const entries = planZipEntries([
      { document: a, artifact: aPdf, folder: "invoices" },
      { document: b, artifact: bPdf, folder: "invoices" },
      { document: a, artifact: aPdf, folder: "invoices" },
      { document: b, artifact: bXml, folder: "invoices" },
      { document: a, artifact: aPdf, folder: undefined },
    ]);
    expect(entries.map((entry) => entry.p)).toEqual([
      "invoices/Invoice.pdf",
      "invoices/Invoice (DOC00B).pdf",
      "invoices/Invoice (DOC00B-xml).pdf",
    ]);
    expect(entries.map((entry) => [entry.d, entry.k, entry.b])).toEqual([
      [a.id, "pdf", 42],
      [b.id, "pdf", 42],
      [b.id, "xml", 42],
    ]);
  });
});
