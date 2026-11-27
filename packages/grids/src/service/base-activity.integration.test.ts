import { afterAll, beforeAll, describe, expect } from "bun:test";
import { sql } from "@k2b/cloud";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../integration-test-utils";
import { migrate } from "../migrate";
import { BASE_ACTIVITY_DAYS, type BaseActivity, getBaseActivity } from "./base-activity";
import { deleteTestWorkflowScope, insertTestWorkflow, insertTestWorkflowRun } from "./workflow-test-fixture";

const postgresTest = testFor("database");
const uuid = () => Bun.randomUUIDv7();

// 26 Oct 2026, 10:00 UTC; the base home charts the 14 days up to that one in Berlin.
const NOW = new Date("2026-10-26T10:00:00.000Z");

const fixture = {
  userId: uuid(),
  baseId: uuid(),
  orders: uuid(),
  parts: uuid(),
  secret: uuid(),
  titleField: uuid(),
  workflowId: uuid(),
  hiddenWorkflowId: uuid(),
  records: [] as string[],
};

const record = async (tableId: string, createdAt: string, updatedAt: string, data: Record<string, unknown> = {}) => {
  const id = uuid();
  fixture.records.push(id);
  await sql`INSERT INTO grids.records (id, short_id, table_id, data, created_at, updated_at, updated_by)
    VALUES (${id}::uuid, ${testShortId()}, ${tableId}::uuid, ${data}::jsonb, ${createdAt}::timestamptz, ${updatedAt}::timestamptz,
      ${fixture.userId}::uuid)`;
  return id;
};

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
    VALUES (${fixture.userId}::uuid, ${`base-activity-${fixture.userId}`}, 'local', 'user', 'Mira Solberg', 'Mira', 'Solberg')`;
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${fixture.baseId}::uuid, ${testShortId()}, 'Werkstatt')`;
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name, position) VALUES
    (${fixture.orders}::uuid, ${testShortId()}, ${fixture.baseId}::uuid, 'Aufträge', 0),
    (${fixture.parts}::uuid, ${testShortId()}, ${fixture.baseId}::uuid, 'Ersatzteile', 1),
    (${fixture.secret}::uuid, ${testShortId()}, ${fixture.baseId}::uuid, 'Gehälter', 2)`;
  await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position, presentable)
    VALUES (${fixture.titleField}::uuid, ${testShortId()}, ${fixture.orders}::uuid, 'Titel', 'text', '{}'::jsonb, 0, TRUE)`;
  // Aufträge: one before the window, one on its first Berlin day, two today (one of them in the bin)
  await record(fixture.orders, "2026-10-01T09:00:00Z", "2026-10-01T09:00:00Z");
  await record(fixture.orders, "2026-10-12T22:30:00Z", "2026-10-12T22:30:00Z");
  const today = await record(fixture.orders, "2026-10-26T08:00:00Z", "2026-10-26T09:50:00Z", { [fixture.titleField]: "Küchenfront Eiche" });
  const binned = await record(fixture.orders, "2026-10-26T08:30:00Z", "2026-10-26T08:30:00Z");
  await sql`UPDATE grids.records SET deleted_at = now() WHERE id = ${binned}::uuid`;
  // Ersatzteile: one yesterday
  await record(fixture.parts, "2026-10-25T12:00:00Z", "2026-10-25T12:00:00Z");
  // Gehälter: unreadable for the viewer, so it counts nowhere
  await record(fixture.secret, "2026-10-26T07:00:00Z", "2026-10-26T09:59:00Z");
  // one finalization waits on a readable table, one on the unreadable one
  for (const tableId of [fixture.orders, fixture.secret])
    await sql`INSERT INTO grids.record_finalization_requests (short_id, table_id, record_id, record_version, policy_revision, requested_by)
      SELECT ${testShortId()}, ${tableId}::uuid, id, 1, 1, ${fixture.userId}::uuid FROM grids.records
      WHERE table_id = ${tableId}::uuid AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`;
  await insertTestWorkflow({ id: fixture.workflowId, baseId: fixture.baseId, name: "Rechnung", shortId: testShortId(), enabled: true });
  await insertTestWorkflow({ id: fixture.hiddenWorkflowId, baseId: fixture.baseId, name: "Lohn", shortId: testShortId(), enabled: true });
  await insertTestWorkflowRun({
    workflowId: fixture.workflowId,
    baseId: fixture.baseId,
    state: "failed",
    createdAt: new Date("2026-10-26T06:00:00Z"),
  });
  await insertTestWorkflowRun({
    workflowId: fixture.workflowId,
    baseId: fixture.baseId,
    state: "failed",
    createdAt: new Date("2026-10-24T06:00:00Z"),
  });
  await insertTestWorkflowRun({
    workflowId: fixture.workflowId,
    baseId: fixture.baseId,
    state: "succeeded",
    createdAt: new Date("2026-10-26T07:00:00Z"),
  });
  await insertTestWorkflowRun({
    workflowId: fixture.hiddenWorkflowId,
    baseId: fixture.baseId,
    state: "failed",
    createdAt: new Date("2026-10-26T06:30:00Z"),
  });
  expect(today).toBeTruthy();
});

afterAll(async () => {
  if (!testInfra.database) return;
  await deleteTestWorkflowScope(fixture.baseId);
  await sql`DELETE FROM grids.record_finalization_requests WHERE table_id IN (${fixture.orders}::uuid, ${fixture.parts}::uuid, ${fixture.secret}::uuid)`;
  await sql`DELETE FROM grids.records WHERE table_id IN (${fixture.orders}::uuid, ${fixture.parts}::uuid, ${fixture.secret}::uuid)`;
  await sql`DELETE FROM grids.fields WHERE id = ${fixture.titleField}::uuid`;
  await sql`DELETE FROM grids.tables WHERE base_id = ${fixture.baseId}::uuid`;
  await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
  await sql`DELETE FROM auth.users WHERE id = ${fixture.userId}::uuid`;
});

describe("the activity of a base", () => {
  postgresTest(
    "counts the readable tables' records by the viewer's days, their exceptions and who changed what last, in two statements",
    async () => {
      const meter = await meterSql();
      let activity: BaseActivity | undefined;
      try {
        const statements = await meter.during(async () => {
          activity = await getBaseActivity(fixture.baseId, [fixture.orders, fixture.parts], [fixture.workflowId], {
            timeZone: "Europe/Berlin",
            now: NOW,
          });
        });
        expect(statements).toHaveLength(2);
      } finally {
        await meter.close();
      }
      expect(activity?.total).toBe(4);
      expect(activity?.points).toHaveLength(BASE_ACTIVITY_DAYS);
      // 12 Oct 22:30 UTC is 13 Oct in Berlin, the window's first day; one new today in Aufträge, one yesterday in Ersatzteile
      expect(activity?.points[0]).toBe(1);
      expect(activity?.points.at(-2)).toBe(1);
      expect(activity?.points.at(-1)).toBe(1);
      expect(activity?.tables[fixture.orders]?.total).toBe(3);
      expect(activity?.tables[fixture.parts]?.total).toBe(1);
      expect(activity?.tables[fixture.secret]).toBeUndefined();
      expect(activity?.pendingFinalizations).toBe(1);
      expect(activity?.failedRuns24h).toBe(1);
      // the newest change of a readable table first, with its title and the person
      expect(activity?.recent[0]).toEqual({
        tableId: fixture.orders,
        recordShortId: expect.any(String),
        title: "Küchenfront Eiche",
        updatedAt: "2026-10-26T09:50:00.000Z",
        user: { id: fixture.userId, name: "Mira Solberg", avatarHash: null },
      });
      expect(activity?.recent.some((change) => change.tableId === fixture.secret)).toBe(false);
    },
  );

  postgresTest("a base with nothing readable spends no statement", async () => {
    const meter = await meterSql();
    try {
      const statements = await meter.during(async () => {
        const activity = await getBaseActivity(fixture.baseId, [], [], { timeZone: "Europe/Berlin", now: NOW });
        expect(activity.total).toBe(0);
        expect(activity.points).toEqual(Array.from({ length: BASE_ACTIVITY_DAYS }, () => 0));
      });
      expect(statements).toHaveLength(0);
    } finally {
      await meter.close();
    }
  });
});
