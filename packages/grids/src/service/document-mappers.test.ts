import { describe, expect, test } from "bun:test";
import type { DocumentArtifact } from "../contracts";
import { mapDocument, mapDocumentSummary, summarizeDocument } from "./document-mappers";

const row = {
  id: "document-id",
  short_id: "DOC001",
  template_id: "template-id",
  workflow_run_id: "workflow-id",
  snapshot_id: "snapshot-id",
  base_id: "base-id",
  table_id: "table-id",
  record_id: "record-id",
  document_number: "INV-1",
  filename: "invoice.pdf",
  primary_artifact_key: "pdf",
  tags: ["paid"],
  profile_id: "invoice",
  profile_version: 1,
  validation_status: "warning",
  created_by: "actor-id",
  created_at: new Date("2026-09-08T12:00:00Z"),
};
const pdf: DocumentArtifact = {
  key: "pdf",
  fileId: "file-id",
  filename: row.filename,
  mimeType: "application/pdf",
  sizeBytes: 42,
  sha256: "a".repeat(64),
};
const artifacts = [pdf, { ...pdf, key: "xml", fileId: "xml-file-id", filename: "invoice.xml", mimeType: "application/xml" }];

describe("document summary mapping", () => {
  test("workflow sources have no fabricated record binding and partial bindings are rejected", () => {
    const workflow = { ...row, template_id: null, snapshot_id: null, table_id: null, record_id: null, workflow_run_id: Bun.randomUUIDv7() };
    expect(mapDocumentSummary(workflow, artifacts)).toMatchObject({
      templateId: null,
      snapshotId: null,
      tableId: null,
      recordId: null,
      workflowRunId: workflow.workflow_run_id,
    });
    expect(() => mapDocumentSummary({ ...workflow, workflow_run_id: null }, artifacts)).toThrow("document source invariant");
    for (const key of ["template_id", "snapshot_id", "table_id", "record_id"]) {
      expect(() => mapDocumentSummary({ ...row, [key]: null }, artifacts)).toThrow("document source invariant");
      expect(() => mapDocumentSummary({ ...workflow, [key]: Bun.randomUUIDv7() }, artifacts)).toThrow("document source invariant");
    }
  });
  test("matches full document summaries including structured artifact metadata", () => {
    const full = mapDocument({ ...row, template_snapshot: { renderer: "test" }, render_data: { record: {} } }, artifacts);
    expect(mapDocumentSummary(row, artifacts)).toEqual(summarizeDocument(full));
    expect(full.templateSnapshot).toEqual({ renderer: "test" });
    expect(full.renderData).toEqual({ record: {} });
  });

  test("does not read frozen payloads", () => {
    const summary = mapDocumentSummary(
      {
        ...row,
        get template_snapshot() {
          throw new Error("Snapshot must not be read");
        },
        get render_data() {
          throw new Error("Render data must not be read");
        },
      },
      artifacts,
    );
    expect(summary).not.toHaveProperty("templateSnapshot");
    expect(summary).not.toHaveProperty("renderData");
    expect(summary.artifacts).toEqual(artifacts);
  });

  test("keeps full document payload validation", () => {
    expect(() => mapDocument({ ...row, template_snapshot: [], render_data: {} }, artifacts)).toThrow("Document template snapshot");
    expect(() => mapDocument({ ...row, template_snapshot: {}, render_data: "invalid" }, artifacts)).toThrow("Document render data");
    expect(() => mapDocument({ ...row, template_snapshot: {}, render_data: '{"record":{}}' }, artifacts)).toThrow(
      "Document render data must be a JSON object",
    );
    expect(() => mapDocument({ ...row, template_snapshot: "{}", render_data: {} }, artifacts)).toThrow(
      "Document template snapshot must be a JSON object",
    );
  });

  test("requires the declared primary artifact and filename for both read shapes", () => {
    for (const invalid of [[], [{ ...pdf, key: "xml" }], [{ ...pdf, filename: "wrong.pdf" }]]) {
      expect(() => mapDocumentSummary(row, invalid)).toThrow("document artifact invariant violated");
      expect(() => mapDocument({ ...row, template_snapshot: {}, render_data: {} }, invalid)).toThrow(
        "document artifact invariant violated",
      );
    }
  });
  test("supports a non-PDF primary artifact without fallback or artifact-order assumptions", () => {
    const summary = mapDocumentSummary({ ...row, primary_artifact_key: "xml", filename: "invoice.xml" }, artifacts);
    expect(summary.primaryArtifactKey).toBe("xml");
    expect(summary.filename).toBe("invoice.xml");
    expect(() => mapDocumentSummary({ ...row, primary_artifact_key: undefined }, artifacts)).toThrow(
      "document artifact invariant violated",
    );
  });
});
