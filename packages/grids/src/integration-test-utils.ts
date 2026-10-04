import { createHash } from "node:crypto";
import { type SQL, sql } from "bun";
import { testFor } from "../../../scripts/fixtures/test-infra";

export const postgresTest = testFor("database");
export const testUuid = () => Bun.randomUUIDv7();
/** Leads every fixture short ID; `newShortId()` never emits `o` or `O`. */
export const TEST_SHORT_ID_MARK = "o";
const shortIdSpace = 36 ** 5;
let shortIdCounter = Date.now() % shortIdSpace;

/**
 * The only source of short IDs for Grids test fixtures, also for bulk SQL
 * inserts. Raw fixture inserts bypass the production `insertWithShortId`
 * retry, so every value must be new to the database: `o` plus a five-digit
 * base36 counter. The counter never repeats within a process and starts at the
 * time this module loads, so a later test process sharing the database starts
 * beyond the IDs of an earlier one only if that one issued fewer IDs than the
 * milliseconds it ran. A process that issues more, like the evidence exports
 * with their 25,001-record test, deletes the rows of that test and of every
 * later test in the process. The `o` keeps fixtures apart from IDs that
 * services generate in the same database. `integration-test-utils.test.ts`
 * flags the common other ways to make up a short ID in Grids database tests.
 */
export const testShortId = () => {
  shortIdCounter = (shortIdCounter + 1) % shortIdSpace;
  return `${TEST_SHORT_ID_MARK}${shortIdCounter.toString(36).padStart(5, "0")}`;
};

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
