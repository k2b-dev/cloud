import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { DocumentArtifactDraft } from "../document-profiles";
import { MAX_DOCUMENT_ARTIFACT_BYTES, validateDocumentArtifactDrafts } from "./document-artifact-drafts";

const pdf = { key: "pdf", mediaType: "application/pdf" };
const csv = { key: "csv", mediaType: "text/csv" };
const draft = (overrides: Partial<DocumentArtifactDraft> = {}): DocumentArtifactDraft => ({
  ...pdf,
  filename: "report.pdf",
  bytes: new TextEncoder().encode("%PDF-1.7\nreport"),
  ...overrides,
});

describe("document artifact output boundary", () => {
  test("validates the selected primary artifact without imposing PDF on other formats", () => {
    const result = validateDocumentArtifactDrafts(
      [draft({ ...csv, filename: "report.csv", bytes: new TextEncoder().encode("Name\r\n") })],
      csv,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.artifacts[0]).toBe(result.data.primary);
    expect(result.data.primary.sha256).toBe(createHash("sha256").update("Name\r\n").digest("hex"));
  });

  test("preserves the PDF requirement for existing PDF renderers", () => {
    for (const artifacts of [[], [draft({ ...csv })], [draft({ bytes: new TextEncoder().encode("%PDFnot-a-header") })]]) {
      expect(validateDocumentArtifactDrafts(artifacts, pdf).ok).toBe(false);
    }
    expect(validateDocumentArtifactDrafts([draft()], pdf).ok).toBe(true);
  });

  test("selects by declared key and rejects mismatched media types", () => {
    const secondary = draft({
      key: "structured",
      mediaType: "application/xml",
      filename: "data.xml",
      bytes: new TextEncoder().encode("<data/>"),
    });
    const result = validateDocumentArtifactDrafts([secondary, draft()], pdf);
    expect(result.ok && result.data.primary.key).toBe("pdf");
    expect(validateDocumentArtifactDrafts([draft({ mediaType: "text/plain" })], pdf).ok).toBe(false);
    expect(validateDocumentArtifactDrafts([draft()], { key: "missing", mediaType: "application/pdf" }).ok).toBe(false);
  });

  test("checks secondary PDFs too", () => {
    expect(
      validateDocumentArtifactDrafts([draft(), draft({ key: "attachment", bytes: new TextEncoder().encode("not a PDF") })], pdf).ok,
    ).toBe(false);
  });

  test("rejects duplicate keys, empty data and excessive artifact counts", () => {
    expect(validateDocumentArtifactDrafts([draft(), draft()], pdf).ok).toBe(false);
    expect(validateDocumentArtifactDrafts([draft({ key: "PDF" })], pdf).ok).toBe(false);
    expect(validateDocumentArtifactDrafts([draft({ bytes: new Uint8Array() })], pdf).ok).toBe(false);
    expect(
      validateDocumentArtifactDrafts(
        Array.from({ length: 9 }, (_, i) => draft({ key: `file${i}` })),
        pdf,
      ).ok,
    ).toBe(false);
  });

  test.each(["", ".", "..", " padded.pdf", "report.pdf ", "../report.pdf", "a\\b.pdf", "a\r\nb.pdf", "a\u007f.pdf", "x".repeat(256)])(
    "rejects unsafe filenames: %j",
    (filename) => expect(validateDocumentArtifactDrafts([draft({ filename })], pdf).ok).toBe(false),
  );

  test.each([
    "",
    "application/pdf\r\nX-Test: yes",
    " application/pdf",
    "application/pdf ",
    "not-a-type",
    "application/pdf\0",
    "application/pdf; charset=utf-8",
  ])("rejects noncanonical or unsafe content types: %j", (mediaType) =>
    expect(validateDocumentArtifactDrafts([draft({ mediaType })], { key: "pdf", mediaType }).ok).toBe(false),
  );

  test("enforces the combined byte budget before hashing or copying", () => {
    const bytes = new Uint8Array(MAX_DOCUMENT_ARTIFACT_BYTES / 2 + 1);
    const result = validateDocumentArtifactDrafts([draft({ ...csv, bytes }), draft({ key: "second", mediaType: "text/csv", bytes })], csv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("byte limit");
  });

  test("detaches validated bytes from the renderer buffer", () => {
    const source = draft();
    const result = validateDocumentArtifactDrafts([source], pdf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    source.bytes.fill(0);
    expect(new TextDecoder().decode(result.data.primary.bytes)).toBe("%PDF-1.7\nreport");
    expect(result.data.primary.sha256).toBe(createHash("sha256").update(result.data.primary.bytes).digest("hex"));
  });

  test("returns a localized bounded error without artifact contents", () => {
    const result = validateDocumentArtifactDrafts([draft()], csv, "de-CH");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BAD_INPUT");
      expect(result.error.message).toContain("Hauptdatei „csv“");
    }
  });
});
