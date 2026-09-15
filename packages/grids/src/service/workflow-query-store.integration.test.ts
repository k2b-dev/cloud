import { beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { migrate as migrateCoreWorkflows } from "../../../core/src/migrate/core/workflows";
import { toPublicWorkflowPayloads } from "../api/workflow-api-shared";
import { migrate } from "../migrate";
import { cleanupFixture, ctx, insertDslDbFixture, postgresTest } from "../query-dsl/sql-compiler.integration-fixtures";
import { canonicalDocumentJson } from "./document-json";
import { newShortId } from "./short-id";
import { bindWorkflowQueryData, captureWorkflowQueryData } from "./workflow-query-data";
import { findWorkflowDocumentDataForStep, loadWorkflowQueryData, persistWorkflowQueryDataInTransaction } from "./workflow-query-store";
import { deleteTestWorkflowScope, insertTestWorkflow, insertTestWorkflowRun } from "./workflow-test-fixture";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST !== "1") return;
  await migrateCoreWorkflows();
  await migrate();
});

postgresTest("query payload is immutable, scoped, deduplicated and rolls back with its step transaction", async () => {
  const fixture = await insertDslDbFixture();
  try {
    const workflowId = await insertTestWorkflow({ baseId: fixture.baseId, shortId: newShortId() });
    const runId = await insertTestWorkflowRun({ baseId: fixture.baseId, workflowId, state: "succeeded", shortId: newShortId() });
    const bound = bindWorkflowQueryData("from table Orders\nselect Amount as exported_amount", ctx(fixture), {});
    if (!bound.ok) throw new Error(bound.error.message);
    const captured = await captureWorkflowQueryData({
      baseId: fixture.baseId,
      binding: bound.data.binding,
      values: {},
      timeZone: "UTC",
      createTableAccess: async () => async () => true,
    });
    if (!captured.ok) throw new Error(captured.error.message);
    const input = { baseId: fixture.baseId, runId, stepKey: "steps.0", capture: captured.data };
    await expect(
      sql.begin(async (tx) => {
        const persisted = await persistWorkflowQueryDataInTransaction(input, tx);
        if (!persisted.ok) throw new Error(persisted.error.message);
        throw new Error("simulated lost step transaction");
      }),
    ).rejects.toThrow("simulated lost step transaction");
    const [rolledBack] = await sql`SELECT count(*)::int AS count FROM grids.workflow_query_data WHERE run_id = ${runId}::uuid`;
    expect(rolledBack.count).toBe(0);

    const stored = await sql.begin((tx) => persistWorkflowQueryDataInTransaction(input, tx));
    if (!stored.ok) throw new Error(stored.error.message);
    expect(stored.data).not.toHaveProperty("payload");
    expect(stored.data).not.toHaveProperty("rows");
    expect(await sql.begin((tx) => persistWorkflowQueryDataInTransaction(input, tx))).toEqual(stored);
    const loaded = await loadWorkflowQueryData({ baseId: fixture.baseId, runId, id: stored.data.id, sha256: stored.data.sha256 }, sql);
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.data.payload).toEqual(captured.data.payload);
    const [publicReference] = await toPublicWorkflowPayloads([stored.data]);
    expect(publicReference).toEqual({
      kind: stored.data.kind,
      stepKey: "steps.0",
      sha256: stored.data.sha256,
      rowCount: stored.data.rowCount,
      capturedAt: stored.data.capturedAt,
    });
    expect(await findWorkflowDocumentDataForStep({ baseId: fixture.baseId, runId, stepKey: "steps.0" }, sql)).toEqual(loaded);
    await expect(
      Promise.resolve(sql`UPDATE grids.workflow_run_profile SET captured_bytes = NULL WHERE run_id = ${runId}::uuid`),
    ).rejects.toMatchObject({ errno: "23502" });
    expect(await sql.begin((tx) => persistWorkflowQueryDataInTransaction(input, tx))).toEqual(stored);
    const [accounted] = await sql`
      SELECT profile.captured_bytes::text AS bytes
      FROM grids.workflow_run_profile profile WHERE run_id = ${runId}::uuid
    `;
    expect(accounted.bytes).toBe(String(new TextEncoder().encode(JSON.stringify(captured.data.payload)).byteLength));
    for (const scope of [
      { baseId: Bun.randomUUIDv7(), runId },
      { baseId: fixture.baseId, runId: Bun.randomUUIDv7() },
    ]) {
      const denied = await loadWorkflowQueryData({ ...scope, id: stored.data.id, sha256: stored.data.sha256 }, sql);
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("NOT_FOUND");
      expect(await findWorkflowDocumentDataForStep({ ...scope, stepKey: "steps.0" }, sql)).toEqual({ ok: true, data: null });
    }
    const changedHash = await loadWorkflowQueryData({ baseId: fixture.baseId, runId, id: stored.data.id, sha256: "0".repeat(64) }, sql);
    expect(changedHash.ok).toBe(false);
    await expect(
      Promise.resolve(sql`UPDATE grids.workflow_query_data SET row_count = 0 WHERE id = ${stored.data.id}::uuid`),
    ).rejects.toThrow("immutable");
    const badInput = await sql.begin((tx) =>
      persistWorkflowQueryDataInTransaction({ ...input, capture: { ...captured.data, rowCount: 999 } }, tx),
    );
    expect(badInput.ok).toBe(false);
    const fresh = await captureWorkflowQueryData({
      baseId: fixture.baseId,
      binding: bound.data.binding,
      values: {},
      timeZone: "UTC",
      createTableAccess: async () => async () => true,
    });
    if (!fresh.ok) throw new Error(fresh.error.message);
    const conflict = await sql.begin((tx) => persistWorkflowQueryDataInTransaction({ ...input, capture: fresh.data }, tx));
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("CONFLICT");

    const largePayload = { ...captured.data.payload, context: { padding: "x".repeat(3 * 1024 * 1024) } };
    const largeCanonical = canonicalDocumentJson(largePayload);
    const large = {
      ...input,
      capture: { ...captured.data, payload: largePayload, sha256: largeCanonical.sha256 },
    };
    await expect(
      sql.begin(async (tx) => {
        const result = await persistWorkflowQueryDataInTransaction({ ...large, stepKey: "rollback-large" }, tx);
        if (!result.ok) throw result.error;
        throw new Error("rollback budget");
      }),
    ).rejects.toThrow("rollback budget");
    const outcomes = await Promise.all(
      ["large-a", "large-b"].map((stepKey) =>
        sql.begin((tx) => persistWorkflowQueryDataInTransaction({ ...large, stepKey, locale: "de" }, tx)),
      ),
    );
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    const rejected = outcomes.find((result) => !result.ok);
    expect(rejected?.ok).toBe(false);
    if (rejected && !rejected.ok) {
      expect(rejected.error.code).toBe("BAD_INPUT");
      expect(rejected.error.message).toContain("Quelldatenbudget");
    }
    const winner = outcomes.findIndex((result) => result.ok);
    const winningResult = outcomes[winner];
    if (!winningResult?.ok) throw new Error("expected one successful capture");
    const [beforeReplay] = await sql`SELECT captured_bytes::text AS bytes FROM grids.workflow_run_profile WHERE run_id = ${runId}::uuid`;
    expect(beforeReplay.bytes).toBe(
      String(
        new TextEncoder().encode(JSON.stringify(captured.data.payload)).byteLength +
          new TextEncoder().encode(JSON.stringify(largePayload)).byteLength,
      ),
    );
    expect(
      await sql.begin((tx) => persistWorkflowQueryDataInTransaction({ ...large, stepKey: winner === 0 ? "large-a" : "large-b" }, tx)),
    ).toEqual(winningResult);
    const [afterReplay] = await sql`SELECT captured_bytes::text AS bytes FROM grids.workflow_run_profile WHERE run_id = ${runId}::uuid`;
    expect(afterReplay.bytes).toBe(beforeReplay.bytes);
    const [count] =
      await sql`SELECT count(*)::int AS count FROM grids.workflow_query_data WHERE run_id = ${runId}::uuid AND step_key LIKE 'large-%'`;
    expect(count.count).toBe(1);
  } finally {
    await deleteTestWorkflowScope(fixture.baseId);
    await cleanupFixture(fixture.baseId);
  }
});
