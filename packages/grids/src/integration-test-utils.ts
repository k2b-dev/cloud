import { createHash } from "node:crypto";
import { type SQL, sql } from "bun";
import { testFor } from "../../../scripts/fixtures/test-infra";

export const postgresTest = testFor("database");
export const testUuid = () => Bun.randomUUIDv7();
const shortIdSpace = 36 ** 5;
let shortIdCounter = Date.now() % shortIdSpace;

/**
 * Six-character short id for raw fixture inserts that bypass the production
 * `insertWithShortId` retry: a one-character prefix plus a five-digit base36
 * counter. The counter never repeats within a process, and it starts at the
 * process start time so later test processes sharing one database stay ahead
 * of earlier ones; fixtures cannot collide on `idx_grids_*_short_id`.
 */
export const testShortId = (prefix: string) => {
  shortIdCounter = (shortIdCounter + 1) % shortIdSpace;
  return `${prefix.slice(0, 1)}${shortIdCounter.toString(36).padStart(5, "0")}`;
};

export const insertTestDocumentArtifact = async (params: {
  documentId: string;
  baseId: string;
  tableId: string | null;
  recordId: string | null;
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
