import { createHash } from "node:crypto";
import { type SQL, sql } from "bun";
import { testFor } from "../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../scripts/fixtures/test-short-id";

export const postgresTest = testFor("database");
export const testUuid = () => Bun.randomUUIDv7();
// A process that issues more short IDs than the milliseconds it runs, like the 25,001-record evidence
// export test, deletes the rows of that test and of every later test in the process (see testShortId).
export { TEST_SHORT_ID_MARK, testShortId } from "../../../scripts/fixtures/test-short-id";

/**
 * The Record change feed withholds a change until every older transaction on
 * the PostgreSQL server has ended. Call this between a test's writes and its
 * feed reads, so an unrelated open transaction elsewhere on the shared test
 * server cannot race the assertions.
 */
export const awaitRecordChangeFeedHorizon = async (): Promise<void> => {
  const [current] = await sql<Array<{ txid: string }>>`SELECT pg_current_xact_id()::text AS txid`;
  for (;;) {
    const [horizon] = await sql<Array<{ passed: boolean }>>`
      SELECT ${current!.txid}::xid8 < pg_snapshot_xmin(pg_current_snapshot()) AS passed
    `;
    if (horizon?.passed) return;
    await Bun.sleep(10);
  }
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
    VALUES (${fileId}::uuid, ${testShortId()}, ${params.filename ?? "test.pdf"}, 'application/pdf', ${bytes.byteLength}, ${sha256}, ${bytes})
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
