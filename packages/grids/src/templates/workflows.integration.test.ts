import { beforeAll, describe, expect } from "bun:test";
import type { WorkflowBoundPlan, WorkflowJsonValue } from "@k2b/cloud/workflows";
import { createWorkflowRun } from "@k2b/cloud/workflows/store";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { create, get, update } from "../service/records";
import { instantiate } from "../service/templates";
import type { GridRecord } from "../service/types";
import { GRIDS_APP_ID, gridsAuthorizationSnapshot } from "../service/workflow-runs";
import { dryRunGridsWorkflowRun, runGridsWorkflowRun } from "../service/workflow-runtime";
import { deleteTestWorkflowScope, publishTestWorkflowVersion } from "../service/workflow-test-fixture";

type Fixture = { baseId: string; actorId: string };
type Table = { id: string; fields: Map<string, string> };
type Workflow = { id: string; version_id: string; source: string; plan: WorkflowBoundPlan };

const required = <T>(value: T | undefined | null, label: string): T => {
  if (value == null) throw new Error(`Missing fixture ${label}`);
  return value;
};

const withFixture = async (templateId: string, run: (fixture: Fixture) => Promise<void>) => {
  const actorId = testUuid();
  const result = await instantiate(templateId, { name: `Template workflow test ${testUuid()}`, withSampleData: true }, null, "en");
  if (!result.ok) throw new Error(result.error.message);
  const baseId = result.data.id;
  try {
    await sql`
      INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
      VALUES (${actorId}::uuid, ${`template-test-${actorId}`}, 'local', 'user', 'Template test', 'Template', 'Test')
    `;
    const [access] = await sql<Array<{ id: string }>>`
      INSERT INTO auth.access (user_id, permission) VALUES (${actorId}::uuid, 'write') RETURNING id::text
    `;
    await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${required(access, "access").id}::uuid)`;
    await run({ baseId, actorId });
  } finally {
    await deleteTestWorkflowScope(baseId);
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    await sql`DELETE FROM auth.access WHERE user_id = ${actorId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${actorId}::uuid`;
  }
};

const table = async (fixture: Fixture, name: string): Promise<Table> => {
  const [row] = await sql<Array<{ id: string }>>`
    SELECT id::text FROM grids.tables WHERE base_id = ${fixture.baseId}::uuid AND name = ${name} AND deleted_at IS NULL
  `;
  const id = required(row, name).id;
  const fields = await sql<Array<{ id: string; name: string }>>`
    SELECT id::text, name FROM grids.fields WHERE table_id = ${id}::uuid AND deleted_at IS NULL
  `;
  return { id, fields: new Map(fields.map((field) => [field.name, field.id])) };
};
const field = (table: Table, name: string) => required(table.fields.get(name), name);
const values = (table: Table, data: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(data).map(([name, value]) => [field(table, name), value]));
const records = async (table: Table): Promise<GridRecord[]> => {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id::text FROM grids.records WHERE table_id = ${table.id}::uuid AND deleted_at IS NULL ORDER BY created_at, id
  `;
  return Promise.all(rows.map(async (row) => required(await get(table.id, row.id), "record")));
};
const edit = async (fixture: Fixture, table: Table, record: GridRecord, data: Record<string, unknown>) => {
  const result = await update(table.id, record.id, values(table, data), fixture.actorId, "workflow");
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};
const add = async (fixture: Fixture, table: Table, data: Record<string, unknown>) => {
  const result = await create(table.id, values(table, data), fixture.actorId, "workflow");
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};
const value = async (table: Table, record: GridRecord, name: string) =>
  required(await get(table.id, record.id), "record").data[field(table, name)];
const relationId = (table: Table, record: GridRecord, name: string): string => {
  const ids = record.data[field(table, name)];
  if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string") throw new Error(`Missing exact ${name} relation`);
  return ids[0];
};
const ref = (record: GridRecord): WorkflowJsonValue => ({ kind: "record", tableId: record.tableId, recordId: record.id });

const workflow = async (fixture: Fixture, name: string, claimOnly = false): Promise<Workflow> => {
  const [row] = await sql<Workflow[]>`
    SELECT w.id::text, v.id::text AS version_id, v.source, v.plan
    FROM grids.workflow_profile p
    JOIN workflows.workflow w ON w.id = p.id
    JOIN workflows.version v ON v.id = w.active_version_id
    WHERE p.base_id = ${fixture.baseId}::uuid AND w.name = ${name} AND p.deleted_at IS NULL
  `;
  const result = required(row, name);
  if (!claimOnly) return result;
  // Keep every authored guard and the real atomic claim. Never execute PDF,
  // public-link or email effects against the local stack in these tests.
  const boundary = result.plan.steps.findIndex((step) => step.kind === "action" && step.action === "generateDocument");
  expect(boundary).toBeGreaterThan(0);
  const plan = { ...result.plan, steps: result.plan.steps.slice(0, boundary) };
  expect(plan.steps.some((step) => step.kind === "action" && step.action === "atomicRecords")).toBe(true);
  const revision = await publishTestWorkflowVersion(result.id, result.source, plan);
  const [version] = await sql<Array<{ id: string }>>`
    SELECT id::text FROM workflows.version WHERE workflow_id = ${result.id}::uuid AND revision = ${revision}
  `;
  return { ...result, version_id: required(version, "claim version").id, plan };
};

const queue = async (
  fixture: Fixture,
  workflow: Workflow,
  inputs: Record<string, WorkflowJsonValue>,
  mode: "execute" | "dryRun" = "execute",
) => {
  const authorization = gridsAuthorizationSnapshot(
    { userId: fixture.actorId, groupIds: [], serviceAccountId: null },
    { kind: "workflow" },
    null,
  );
  const runId = await createWorkflowRun({
    appId: GRIDS_APP_ID,
    scopeId: fixture.baseId,
    workflowId: workflow.id,
    workflowVersionId: workflow.version_id,
    mode,
    inputs,
    context: {},
    authorization,
    idempotencyKey: testUuid(),
    occurredAt: new Date(),
  });
  await sql`
    INSERT INTO grids.workflow_run_profile (run_id, short_id, base_id, workflow_id, channel, actor_user_id, request_fingerprint)
    VALUES (${runId}::uuid, ${testShortId("R")}, ${fixture.baseId}::uuid, ${workflow.id}::uuid, 'api', ${fixture.actorId}::uuid, ${runId})
  `;
  return runId;
};
const drive = async (runId: string, mode: "execute" | "dryRun" = "execute") => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (mode === "dryRun") await dryRunGridsWorkflowRun(runId);
    else await runGridsWorkflowRun(runId);
    const [row] = await sql<Array<{ state: string; error: unknown }>>`SELECT state, error FROM workflows.run WHERE id = ${runId}::uuid`;
    const run = required(row, "run");
    if (["succeeded", "failed", "canceled", "needs_attention"].includes(run.state)) return run;
    await Bun.sleep(10);
  }
  throw new Error(`Run ${runId} did not settle`);
};
const invoke = async (fixture: Fixture, workflow: Workflow, inputs: Record<string, WorkflowJsonValue>) =>
  drive(await queue(fixture, workflow, inputs));

describe("authored template workflow transitions", () => {
  beforeAll(async () => {
    if (process.env.GRIDS_DB_TEST !== "1") return;
    const target = new URL(process.env.DATABASE_URL ?? "");
    expect(["localhost", "127.0.0.1"]).toContain(target.hostname);
    expect(target.port || "5432").toBe("5432");
    const [server] = await sql<Array<{ port: number }>>`SELECT inet_server_port() AS port`;
    expect(server?.port).toBe(5432);
    await migrate();
  });

  for (const scenario of [
    { template: "bookshop", workflow: "Send order invoice", table: "Orders", input: "order", delivery: "Invoice delivery" },
    { template: "finance", workflow: "Clear and send receipt", table: "Transactions", input: "transaction", delivery: "Receipt delivery" },
    { template: "inventory", workflow: "Send approved loan agreement", table: "Loans", input: "loan", delivery: "Agreement delivery" },
  ]) {
    postgresTest(
      `${scenario.template}: independent sends claim Processing exactly once`,
      async () => {
        await withFixture(scenario.template, async (fixture) => {
          const target = await table(fixture, scenario.table);
          const candidates = await records(target);
          let record = required(candidates[0], "dispatch record");
          if (scenario.template === "bookshop") {
            record = required(
              candidates.find((candidate) => candidate.data[field(target, "Ready to invoice")] === true),
              "ready order",
            );
            const customers = await table(fixture, "Customers");
            for (const customer of await records(customers)) await edit(fixture, customers, customer, { Email: "fixture@example.invalid" });
          } else if (scenario.template === "finance") {
            await edit(fixture, target, record, { Type: ["expense"], "Receipt email": "fixture@example.invalid" });
          } else {
            const positions = await table(fixture, "Loan positions");
            const position = required((await records(positions))[0], "sample position");
            record = required(
              candidates.find((candidate) => candidate.id === relationId(positions, position, "Loan")),
              "position loan",
            );
            await edit(fixture, target, record, {
              Status: ["approved"],
              "Availability confirmed": true,
              "Requester email": "fixture@example.invalid",
            });
          }
          await edit(fixture, target, record, { [scenario.delivery]: ["ready"] });
          const claim = await workflow(fixture, scenario.workflow, true);
          const inputs = { [scenario.input]: ref(record) };
          const runIds = await Promise.all([queue(fixture, claim, inputs), queue(fixture, claim, inputs)]);
          const outcomes = await Promise.all(runIds.map((runId) => drive(runId)));
          expect(outcomes.map((outcome) => outcome.state).sort(), JSON.stringify(outcomes)).toEqual(["failed", "succeeded"]);
          expect(await value(target, record, scenario.delivery)).toEqual(["processing"]);
          expect((await invoke(fixture, claim, inputs)).state).toBe("failed");
          const [effects] = await sql<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM workflows.step_outcome
          WHERE run_id IN (SELECT id FROM workflows.run WHERE scope_id = ${fixture.baseId})
            AND action IN ('generateDocument', 'sendEmail', 'createDocumentLink')
        `;
          expect(effects?.count).toBe(0);
        });
      },
      60_000,
    );
  }

  postgresTest(
    "inventory: adding positions is deduplicated, stops at approval and rechecks queued access",
    async () => {
      await withFixture("inventory", async (fixture) => {
        const loans = await table(fixture, "Loans");
        const items = await table(fixture, "Items");
        const positions = await table(fixture, "Loan positions");
        const samplePosition = required((await records(positions))[0], "sample position");
        const sampleLoanId = relationId(positions, samplePosition, "Loan");
        const loan = required(
          (await records(loans)).find((candidate) => candidate.id !== sampleLoanId),
          "request loan without positions",
        );
        const item = required((await records(items))[0], "item");
        await edit(fixture, loans, loan, { Status: ["requested"] });
        const addPosition = await workflow(fixture, "Add loan position");
        const inputs = { loan: ref(loan), item: ref(item) };
        const before = (await records(positions)).length;
        const runs = await Promise.all([queue(fixture, addPosition, inputs), queue(fixture, addPosition, inputs)]);
        const outcomes = await Promise.all(runs.map((runId) => drive(runId)));
        expect(outcomes.map((outcome) => outcome.state).sort(), JSON.stringify(outcomes)).toEqual(["failed", "succeeded"]);
        expect(outcomes.find((outcome) => outcome.state === "failed")?.error).toMatchObject({ code: "ATOMIC_CHECK_FAILED" });
        expect(await records(positions)).toHaveLength(before + 1);
        const anotherItem = required((await records(items))[1], "another item");
        for (const status of ["approved", "active", "returned"]) {
          await edit(fixture, loans, loan, { Status: [status] });
          expect(await invoke(fixture, addPosition, { loan: ref(loan), item: ref(anotherItem) })).toMatchObject({
            state: "failed",
            error: { code: "ATOMIC_CHECK_FAILED" },
          });
        }
        expect(await records(positions)).toHaveLength(before + 1);
        await edit(fixture, loans, loan, { Status: ["requested"] });
        const revokedRun = await queue(fixture, addPosition, { loan: ref(loan), item: ref(anotherItem) });
        const revokedPreview = await queue(fixture, addPosition, { loan: ref(loan), item: ref(anotherItem) }, "dryRun");
        await sql`UPDATE auth.access SET permission = 'read' WHERE user_id = ${fixture.actorId}::uuid`;
        expect(await drive(revokedRun)).toMatchObject({ state: "failed", error: { code: "FORBIDDEN" } });
        expect(await drive(revokedPreview, "dryRun")).toMatchObject({
          state: "failed",
          error: { code: "WORKFLOW_DRY_RUN_INDETERMINATE", message: "Workflow actor does not have permission for this action" },
        });
        expect(await records(positions)).toHaveLength(before + 1);
      });
    },
    60_000,
  );

  postgresTest(
    "inventory: competing issue, exact return, replay, reuse and close guards",
    async () => {
      await withFixture("inventory", async (fixture) => {
        const loans = await table(fixture, "Loans");
        const items = await table(fixture, "Items");
        const positions = await table(fixture, "Loan positions");
        const loanRows = await records(loans);
        const firstPosition = required((await records(positions))[0], "planned position");
        const firstLoan = required(
          loanRows.find((candidate) => candidate.id === relationId(positions, firstPosition, "Loan")),
          "first loan",
        );
        const secondLoan = required(
          loanRows.find((candidate) => candidate.id !== firstLoan.id),
          "distinct second loan",
        );
        await edit(fixture, loans, secondLoan, { Status: ["active"] });
        const item = required(await get(items.id, relationId(positions, firstPosition, "Item")), "item");
        const secondPosition = await add(fixture, positions, { Loan: [secondLoan.id], Item: [item.id], Status: ["planned"] });
        expect(relationId(positions, firstPosition, "Loan")).toBe(firstLoan.id);
        expect(relationId(positions, secondPosition, "Loan")).toBe(secondLoan.id);
        expect(firstLoan.id).not.toBe(secondLoan.id);
        const issue = await workflow(fixture, "Issue loan position");
        const close = await workflow(fixture, "Close returned loan");
        const returnItem = await workflow(fixture, "Mark loan item as returned");
        expect(await invoke(fixture, close, { loan: ref(firstLoan) })).toMatchObject({
          state: "failed",
          error: { code: "ATOMIC_CHECK_FAILED" },
        });
        const runIds = await Promise.all(
          [firstPosition, secondPosition].map((position) => queue(fixture, issue, { position: ref(position) })),
        );
        const outcomes = await Promise.all(runIds.map((runId) => drive(runId)));
        expect(outcomes.map((outcome) => outcome.state).sort(), JSON.stringify(outcomes)).toEqual(["failed", "succeeded"]);
        expect(outcomes.find((outcome) => outcome.state === "failed")?.error).toMatchObject({ code: "ATOMIC_CHECK_FAILED" });
        const winnerIndex = outcomes.findIndex((outcome) => outcome.state === "succeeded");
        const winner = required([firstPosition, secondPosition][winnerIndex], "winner");
        const loser = winnerIndex === 0 ? secondPosition : firstPosition;
        const winnerLoan = winnerIndex === 0 ? firstLoan : secondLoan;
        expect(await value(items, item, "Current loan position")).toEqual([winner.id]);
        expect(await value(positions, loser, "Status")).toEqual(["planned"]);
        expect(await invoke(fixture, close, { loan: ref(winnerLoan) })).toMatchObject({
          state: "failed",
          error: { code: "ATOMIC_CHECK_FAILED" },
        });
        const returnRun = await queue(fixture, returnItem, { item: ref(item), condition: "good" });
        expect((await drive(returnRun)).state).toBe("succeeded");
        expect(await value(positions, winner, "Status")).toEqual(["returned"]);
        expect(await value(items, item, "Status")).toEqual(["available"]);
        expect((await invoke(fixture, returnItem, { item: ref(item), condition: "good" })).state).toBe("failed");
        const closed = await invoke(fixture, close, { loan: ref(winnerLoan) });
        expect(closed.state, JSON.stringify(closed)).toBe("succeeded");
        expect((await invoke(fixture, issue, { position: ref(loser) })).state).toBe("succeeded");
        // Retrying the completed original invocation cannot return the new loan.
        expect((await drive(returnRun)).state).toBe("succeeded");
        expect(await value(items, item, "Current loan position")).toEqual([loser.id]);
        expect(await value(positions, loser, "Status")).toEqual(["issued"]);
        expect((await invoke(fixture, returnItem, { item: ref(item), condition: "repair" })).state).toBe("succeeded");
        expect(await value(items, item, "Status")).toEqual(["maintenance"]);
        expect(await value(positions, loser, "Status")).toEqual(["returned"]);
      });
    },
    60_000,
  );
});
