import { describe, expect, test } from "bun:test";
import type { DocumentArtifact } from "../contracts";
import { planWorkflowDocumentsZip } from "./document-core";
import { DOCUMENT_ZIP_MAX_BYTES } from "./document-zip-archive";

const primary = (shortId: string, filename: string, sizeBytes: number) => {
  const artifact: DocumentArtifact = {
    key: "csv",
    fileId: Bun.randomUUIDv7(),
    filename,
    mimeType: "text/csv",
    sizeBytes,
    sha256: "a".repeat(64),
  };
  return { document: { id: Bun.randomUUIDv7(), shortId, tableId: null, artifacts: [artifact] }, artifact };
};

describe("planWorkflowDocumentsZip", () => {
  test("keeps original names, renames clashes and totals the source bytes", () => {
    const planned = planWorkflowDocumentsZip([primary("DOC00A", "export.csv", 10), primary("DOC00B", "export.csv", 20)]);
    if (!planned.ok) throw planned.error;
    expect(planned.data.entries.map((entry) => entry.p)).toEqual(["export.csv", "export (DOC00B).csv"]);
    expect(planned.data.sourceBytes).toBe(30);
  });

  test("rejects an archive over the document ZIP byte bound before streaming", () => {
    const planned = planWorkflowDocumentsZip([primary("DOC00A", "large.csv", DOCUMENT_ZIP_MAX_BYTES)], "de");
    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.error.code).toBe("BAD_INPUT");
      expect(planned.error.message).toContain(`ZIP-Limit von ${DOCUMENT_ZIP_MAX_BYTES} Byte`);
    }
  });
});
