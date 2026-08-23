import { test } from "bun:test";
import { createHash } from "node:crypto";
import { type SQL, sql } from "bun";

export const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;
export const testUuid = () => Bun.randomUUIDv7();
export const testShortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

export const insertTestDocumentArtifact = async (params: {
  documentId: string;
  baseId: string;
  tableId: string;
  recordId: string;
  filename?: string;
  db?: SQL;
}) => {
  const db = params.db ?? sql;
  const fileId = testUuid();
  const bytes = new TextEncoder().encode("%PDF-1.7\ntest document artifact");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const rendererVersion = "grids-test-renderer-v1";
  const templateRevision = createHash("sha256").update("test template").digest("hex");
  await db`
    INSERT INTO grids.files (id, short_id, filename, mime_type, size_bytes, sha256, bytes)
    VALUES (${fileId}::uuid, ${testShortId("P")}, ${params.filename ?? "test.pdf"}, 'application/pdf', ${bytes.byteLength}, ${sha256}, ${bytes})
  `;
  await db`
    INSERT INTO grids.file_protected_references (file_id, owner_kind, owner_id, base_id, table_id, record_id)
    VALUES (
      ${fileId}::uuid, 'document_artifact', ${params.documentId}::uuid,
      ${params.baseId}::uuid, ${params.tableId}::uuid, ${params.recordId}::uuid
    )
  `;
  return {
    fileId,
    mimeType: "application/pdf" as const,
    sizeBytes: bytes.byteLength,
    sha256,
    rendererVersion,
    templateRevision,
    attach: async () => {
      await db`
        INSERT INTO grids.document_artifacts (document_id, artifact_key, file_id)
        VALUES (${params.documentId}::uuid, 'pdf', ${fileId}::uuid)
      `;
    },
  };
};
