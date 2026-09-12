import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { reserveDocumentExportClaims } from "./document-export-claims";
import { deleteTestWorkflowScope, insertTestWorkflow, insertTestWorkflowRun } from "./workflow-test-fixture";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

const fixture = async () => {
  const baseId = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Export claims')`;
  const workflowId = await insertTestWorkflow({ baseId, shortId: testShortId("W") });
  const runId = await insertTestWorkflowRun({ baseId, workflowId, shortId: testShortId("R"), state: "waiting" });
  const queryId = testUuid();
  await sql`INSERT INTO grids.workflow_query_data (id, run_id, step_key, payload, sha256, row_count, captured_at)
    VALUES (${queryId}::uuid, ${runId}::uuid, 'query', '{}'::jsonb, ${"a".repeat(64)}, 0, now())`;
  const receipt = async (confirmed = true) => {
    const receiptId = testUuid();
    const frozen = { output: { kind: "datev-csv", header: { destinationKey: "accounting" } } };
    await sql`INSERT INTO grids.document_issuances (id, base_id, document_short_id, operation_key_hash, request_hash,
      frozen_request, query_data_id, confirmation_hash, confirmed_actor, confirmed_at)
      VALUES (${receiptId}::uuid, ${baseId}::uuid, ${testShortId("D")}, ${new Bun.CryptoHasher("sha256").update(receiptId).digest("hex")},
        ${"b".repeat(64)}, ${frozen}::jsonb, ${queryId}::uuid, ${"c".repeat(64)},
        ${confirmed ? { kind: "user", userId: testUuid() } : null}::jsonb, CASE WHEN ${confirmed} THEN now() ELSE NULL END)`;
    return receiptId;
  };
  const reserve = (receiptId: string, businessIds: string[]) =>
    sql.begin((tx) =>
      reserveDocumentExportClaims(tx, {
        baseId,
        receiptId,
        businessIds,
        destinationKey: "accounting",
        purpose: "accounting",
      }),
    );
  const cleanup = async () => {
    await sql`UPDATE workflows.run SET state = 'canceled' WHERE app_id = 'grids' AND scope_id = ${baseId}`;
    await sql`DELETE FROM grids.document_export_claims WHERE base_id = ${baseId}::uuid`;
    await sql`DELETE FROM grids.document_issuances WHERE base_id = ${baseId}::uuid`;
    await deleteTestWorkflowScope(baseId);
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  };
  return { baseId, runId, receipt, reserve, cleanup };
};

describe("financial export claims", () => {
  postgresTest("overlapping batches reserve all identities or none and replay the same receipt", async () => {
    const scope = await fixture();
    try {
      const first = await scope.receipt();
      const second = await scope.receipt();
      const results = await Promise.allSettled([scope.reserve(first, ["A", "B"]), scope.reserve(second, ["B", "C"])]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const claims = await sql<Array<{ business_id: string; receipt_id: string }>>`
        SELECT business_id, receipt_id::text FROM grids.document_export_claims WHERE base_id = ${scope.baseId}::uuid ORDER BY business_id`;
      expect(claims).toHaveLength(2);
      expect(new Set(claims.map((claim) => claim.receipt_id)).size).toBe(1);
      await scope.reserve(
        claims[0]!.receipt_id,
        claims.map((claim) => claim.business_id),
      );
      const replayed = await sql<
        Array<{ business_id: string; receipt_id: string }>
      >`SELECT business_id, receipt_id::text FROM grids.document_export_claims
        WHERE base_id = ${scope.baseId}::uuid ORDER BY business_id`;
      expect(replayed).toEqual(claims);
    } finally {
      await scope.cleanup();
    }
  });

  postgresTest("confirmation is required and cannot be changed after approval", async () => {
    const scope = await fixture();
    try {
      const receiptId = await scope.receipt(false);
      await expect(scope.reserve(receiptId, ["A"])).rejects.toThrow("confirm");
      await sql`UPDATE grids.document_issuances SET confirmed_actor = ${{ kind: "user", userId: testUuid() }}::jsonb,
        confirmed_at = now() WHERE id = ${receiptId}::uuid`;
      await scope.reserve(receiptId, ["A"]);
      await expect(
        Promise.resolve(sql`UPDATE grids.document_issuances SET confirmed_actor = ${{ kind: "system" }}::jsonb
        WHERE id = ${receiptId}::uuid`),
      ).rejects.toThrow("immutable");
      await expect(
        Promise.resolve(sql`UPDATE grids.document_issuances SET confirmation_hash = ${"d".repeat(64)}
        WHERE id = ${receiptId}::uuid`),
      ).rejects.toThrow("immutable");
      await expect(
        sql.begin((tx) =>
          reserveDocumentExportClaims(tx, {
            baseId: scope.baseId,
            receiptId,
            businessIds: ["A"],
            destinationKey: "changed",
            purpose: "accounting",
          }),
        ),
      ).rejects.toThrow("confirm");
    } finally {
      await scope.cleanup();
    }
  });

  postgresTest("pending claims cannot be edited or released while the run may still execute", async () => {
    const scope = await fixture();
    try {
      const receiptId = await scope.receipt();
      await scope.reserve(receiptId, ["A"]);
      await expect(
        Promise.resolve(sql`UPDATE grids.document_export_claims SET business_id = 'B'
        WHERE receipt_id = ${receiptId}::uuid`),
      ).rejects.toThrow("immutable");
      await expect(
        Promise.resolve(sql`DELETE FROM grids.document_export_claims
        WHERE receipt_id = ${receiptId}::uuid`),
      ).rejects.toThrow("terminal");
      await sql`UPDATE workflows.run SET state = 'canceled' WHERE id = ${scope.runId}::uuid`;
      await sql`DELETE FROM grids.document_export_claims WHERE receipt_id = ${receiptId}::uuid`;
      expect(await sql`SELECT * FROM grids.document_export_claims WHERE receipt_id = ${receiptId}::uuid`).toHaveLength(0);
    } finally {
      await scope.cleanup();
    }
  });
});
