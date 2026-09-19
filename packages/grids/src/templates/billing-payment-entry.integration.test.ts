import { beforeAll, expect } from "bun:test";
import type { WorkflowBoundPlan, WorkflowJsonValue } from "@k2b/cloud/workflows";
import { createWorkflowRun } from "@k2b/cloud/workflows/store";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { previewDslQuery } from "../query-dsl/preview";
import { resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import { buildTrustedGqlResolverContext } from "../service/gql-resolver-context";
import { finalize } from "../service/record-finalization";
import { create } from "../service/records";
import { instantiateDefinition } from "../service/templates";
import { GRIDS_APP_ID, gridsAuthorizationSnapshot } from "../service/workflow-runs";
import { runGridsWorkflowRun } from "../service/workflow-runtime";
import { prepareWorkflowInputs } from "../service/workflow-values";
import { createBillingTemplate } from "./billing";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST !== "1") return;
  const [database] = await sql`SELECT current_database() AS name`;
  if (!database.name.startsWith("grids_verify_")) throw new Error("Payment entry tests require an isolated grids_verify_ database");
  await migrate();
});

const fixture = async (locale: string) => {
  const definition = createBillingTemplate(locale);
  const installed = await instantiateDefinition(definition, { withSampleData: false }, null, locale);
  if (!installed.ok) throw new Error(installed.error.message);
  const baseId = installed.data.id;
  const actorId = testUuid();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
    VALUES (${actorId}::uuid, ${actorId}, 'local', 'user', 'Payment test', 'Payment', 'Test')`;
  const [access] = await sql`INSERT INTO auth.access (user_id, permission) VALUES (${actorId}::uuid, 'write') RETURNING id`;
  await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${access.id}::uuid)`;
  const table = async (key: string) => {
    const spec = definition.tables.find((entry) => entry.key === key)!;
    const [row] = await sql<
      Array<{ id: string }>
    >`SELECT id::text FROM grids.tables WHERE base_id = ${baseId}::uuid AND name = ${spec.name}`;
    const fields = await sql<
      Array<{ id: string; name: string }>
    >`SELECT id::text, name FROM grids.fields WHERE table_id = ${row!.id}::uuid`;
    const ids = Object.fromEntries(spec.fields.map((entry) => [entry.key, fields.find((field) => field.name === entry.name)!.id]));
    return {
      id: row!.id,
      ids,
      add: async (data: Record<string, unknown>) => {
        const values = Object.fromEntries(Object.entries(data).map(([key, value]) => [ids[key]!, value]));
        const result = await create(row!.id, values, actorId, "workflow");
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      },
    };
  };
  const drive = async (runId: string) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      await runGridsWorkflowRun(runId);
      const [run] = await sql<Array<{ state: string; error: unknown }>>`SELECT state, error FROM workflows.run WHERE id = ${runId}::uuid`;
      if (["succeeded", "failed", "needs_attention", "canceled"].includes(run!.state)) return { ...run!, runId };
    }
    throw new Error(`Payment run did not settle: ${runId}`);
  };
  const invoke = async (key: string, inputs: Record<string, WorkflowJsonValue>) => {
    const name = definition.workflows!.find((workflow) => workflow.key === key)!.name;
    const [workflow] = await sql<Array<{ id: string; version_id: string; plan: WorkflowBoundPlan }>>`
      SELECT w.id::text, w.active_version_id::text AS version_id, v.plan FROM grids.workflow_profile p
      JOIN workflows.workflow w ON w.id = p.id JOIN workflows.version v ON v.id = w.active_version_id
      WHERE p.base_id = ${baseId}::uuid AND w.name = ${name}`;
    if (!workflow) throw new Error(`Missing workflow ${name}`);
    const prepared = await prepareWorkflowInputs(workflow.plan, inputs, {
      canReadTable: async () => true,
      resolveRecordIds: async (tableId, ids) => {
        const records = await sql<
          Array<{ id: string }>
        >`SELECT id::text FROM grids.records WHERE table_id = ${tableId}::uuid AND id IN ${sql(ids)} AND deleted_at IS NULL`;
        return new Map(records.map((record) => [record.id, record.id]));
      },
    });
    const runId = await createWorkflowRun({
      appId: GRIDS_APP_ID,
      scopeId: baseId,
      workflowId: workflow.id,
      workflowVersionId: workflow.version_id,
      mode: "execute",
      inputs: prepared,
      context: {},
      authorization: gridsAuthorizationSnapshot({ userId: actorId, groupIds: [], serviceAccountId: null }, { kind: "workflow" }, null),
      idempotencyKey: testUuid(),
      occurredAt: new Date(),
    });
    await sql`INSERT INTO grids.workflow_run_profile (run_id, short_id, base_id, workflow_id, channel, actor_user_id, request_fingerprint)
      VALUES (${runId}::uuid, ${testShortId("R")}, ${baseId}::uuid, ${workflow.id}::uuid, 'api', ${actorId}::uuid, ${runId})`;
    return drive(runId);
  };
  const balance = async (recordId: string) => {
    const name = definition.views!.find((view) => view.key === "balances")!.name;
    const [view] = await sql`SELECT source FROM grids.views WHERE base_id = ${baseId}::uuid AND name = ${name}`;
    const parsed = parseGridsQueryDsl(view.source);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    const context = await buildTrustedGqlResolverContext({ baseId, ast: parsed.ast, purpose: "custom-app-render" });
    const resolved = resolveDslQueryToQueryPlan(parsed.ast, context);
    if (!resolved.ok) throw new Error(JSON.stringify(resolved));
    const result = await previewDslQuery(resolved.plan, {
      fieldsByTableId: context.fieldsByTableId,
      authorizedTableIds: new Set(context.tables.map((table) => table.id)),
      primaryTableAuthorized: true,
    });
    if (!result.ok) throw new Error(result.error.message);
    const row = result.data.rows.find((row) => row.recordId === recordId)!;
    return Object.values(row.values).at(-1);
  };
  return { baseId, actorId, table, invoke, drive, balance };
};

for (const locale of ["en", "de"]) {
  postgresTest(
    `${locale}: manual payment entry completes once and guards refunds and payouts`,
    async () => {
      const f = await fixture(locale);
      const parties = await f.table("parties");
      const bills = await f.table("bills");
      const payments = await f.table("payments");
      const partner = await parties.add({ name: "Payment customer" });
      const bill = async (kind: string, finalized = true) => {
        const record = await bills.add({
          kind: [kind],
          party: [partner.id],
          invoice_date: "2026-09-17",
          buyer_reference: "Payment test",
          positions: [{ Label1: "Work", Unit01: ["C62"], Qty001: "1", Price1: "100.00", Vat001: ["vat019"] }],
        });
        if (finalized) {
          const result = await finalize({ tableId: bills.id, recordId: record.id, actorId: f.actorId, origin: "workflow" });
          if (!result.ok) throw new Error(result.error.message);
        }
        return record;
      };
      const invoice = await bill("invoice");
      const draft = await bill("invoice", false);
      const credit = await bill("creditNote");
      const settlement = await bill("selfBilling");
      const input = (id: string, amount: string) => ({
        bill: id,
        date: "2026-09-18",
        amount,
      });
      const rows = () => sql<Array<{ id: string; finalized_at: Date | null; data: Record<string, unknown> }>>`
      SELECT id::text, finalized_at, data FROM grids.records WHERE table_id = ${payments.id}::uuid AND deleted_at IS NULL
    `;
      expect(String(await f.balance(invoice.id))).toBe("119");
      const payment = await f.invoke("record_payment", input(invoice.id, "139.25"));
      expect(payment.state, JSON.stringify(payment.error)).toBe("succeeded");
      let stored = await rows();
      expect(stored).toHaveLength(1);
      expect(stored[0]!.finalized_at).not.toBeNull();
      expect(stored[0]!.data[payments.ids.amount!]).toBe("139.25");
      expect(String(await f.balance(invoice.id))).toBe("-20.25");
      // Preserve the committed effect journal while simulating a resumed attempt.
      await sql`UPDATE workflows.run SET state = 'queued', result = NULL, error = NULL, result_message = NULL,
      finished_at = NULL, lease_owner = NULL, lease_expires_at = NULL, retry_after = NULL WHERE id = ${payment.runId}::uuid`;
      await sql`UPDATE workflows.step_outcome SET state = 'running', outcome = NULL, finished_at = NULL WHERE run_id = ${payment.runId}::uuid`;
      expect((await f.drive(payment.runId)).state).toBe("succeeded");
      expect(await rows()).toHaveLength(1);

      for (const [key, id, amount] of [
        ["record_payment", draft.id, "1"],
        ["record_payment", credit.id, "1"],
        ["record_payment", settlement.id, "1"],
        ["record_payout", invoice.id, "1"],
        ["record_refund", settlement.id, "1"],
        ["record_payment", invoice.id, "-1"],
      ]) {
        const rejected = await f.invoke(key!, input(id!, amount!));
        expect(rejected.state, JSON.stringify(rejected.error)).toBe("failed");
        expect(await rows()).toHaveLength(1);
      }
      const refunds = await Promise.all([
        f.invoke("record_refund", { ...input(invoice.id, "15.00"), reference: "Refund A" }),
        f.invoke("record_refund", { ...input(invoice.id, "15.00"), reference: "Refund B" }),
      ]);
      expect(refunds.map((run) => run.state).sort()).toEqual(["failed", "succeeded"]);
      expect(String(await f.balance(invoice.id))).toBe("-5.25");
      stored = await rows();
      expect(stored).toHaveLength(2);
      expect(stored.every((record) => record.finalized_at !== null)).toBe(true);
      expect(stored.filter((record) => record.data[payments.ids.refund!] === true)).toHaveLength(1);
      const payout = await f.invoke("record_payout", { ...input(settlement.id, "19.25"), reference: "Commission" });
      expect(payout.state, JSON.stringify(payout.error)).toBe("succeeded");
      expect(String(await f.balance(settlement.id))).toBe("99.75");
      expect(await rows()).toHaveLength(3);
    },
    120_000,
  );
}
