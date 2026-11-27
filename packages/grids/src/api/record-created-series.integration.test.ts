import { afterAll, beforeAll, describe, expect } from "bun:test";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../integration-test-utils";
import { migrate } from "../migrate";
import { getRecordCreatedSeries, RECORD_SERIES_DAYS } from "../service/record-created-series";
import { PublicRecordCreatedSeriesSchema, recordsRoutes } from "./records";

const postgresTest = testFor("database");
const uuid = () => Bun.randomUUIDv7();

// 26 Oct 2026, 10:00 UTC: the Sunday before, Europe/Berlin left summer time, so 25 Oct has 25 hours there.
const NOW = new Date("2026-10-26T10:00:00.000Z");

const fixture = {
  readerId: uuid(),
  strangerId: uuid(),
  accessId: "",
  baseId: uuid(),
  basePublicId: testShortId(),
  tableId: uuid(),
  tablePublicId: testShortId(),
  otherTableId: uuid(),
  combinedTableId: uuid(),
  combinedTablePublicId: testShortId(),
};

const record = (tableId: string, createdAt: string, deletedAt: string | null = null) =>
  sql`INSERT INTO grids.records (id, short_id, table_id, data, created_at, deleted_at)
      VALUES (${uuid()}::uuid, ${testShortId()}, ${tableId}::uuid, '{}'::jsonb, ${createdAt}::timestamptz, ${deletedAt}::timestamptz)`;

const user = (id: string): User => ({
  id,
  uid: `record-series-${id}`,
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Record",
  sn: "Series",
  displayName: "Record Series",
  mail: null,
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
});

const api = (userId: string) =>
  new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("actor", { kind: "user", user: user(userId) });
      c.set("user", user(userId));
      c.set("accessSubject", { type: "user", userId });
      await next();
    })
    .route("/", recordsRoutes);

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  for (const id of [fixture.readerId, fixture.strangerId])
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
      VALUES (${id}::uuid, ${`record-series-${id}`}, 'local', 'user', 'Record Series', 'Record', 'Series')`;
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${fixture.baseId}::uuid, ${fixture.basePublicId}, 'Record series')`;
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name, position) VALUES
    (${fixture.tableId}::uuid, ${fixture.tablePublicId}, ${fixture.baseId}::uuid, 'Orders', 0),
    (${fixture.otherTableId}::uuid, ${testShortId()}, ${fixture.baseId}::uuid, 'Parts', 1)`;
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name, position, kind, disable_direct_insert, audit_policy)
    VALUES (${fixture.combinedTableId}::uuid, ${fixture.combinedTablePublicId}, ${fixture.baseId}::uuid, 'All orders', 2,
      'federated', TRUE, '{}'::jsonb)`;
  // 20 Oct, before a 7-day window: counts in the total only
  await record(fixture.tableId, "2026-10-19T12:00:00Z");
  // 20 Oct: the first day of a 7-day window
  await record(fixture.tableId, "2026-10-20T08:00:00Z");
  // 25 Oct 23:30 UTC is 26 Oct 00:30 in Berlin: a different day for the two calendars
  await record(fixture.tableId, "2026-10-25T23:30:00Z");
  await record(fixture.tableId, "2026-10-26T09:00:00Z");
  // in the bin, and of another table: counted nowhere
  await record(fixture.tableId, "2026-10-26T09:30:00Z", "2026-10-26T09:45:00Z");
  await record(fixture.otherTableId, "2026-10-26T09:00:00Z");
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (user_id, permission) VALUES (${fixture.readerId}::uuid, 'read'::auth.permission_level) RETURNING id::text AS id
  `;
  fixture.accessId = access!.id;
  await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${fixture.baseId}::uuid, ${fixture.accessId}::uuid)`;
});

afterAll(async () => {
  if (!testInfra.database) return;
  await sql`DELETE FROM grids.records WHERE table_id IN (${fixture.tableId}::uuid, ${fixture.otherTableId}::uuid)`;
  await sql`DELETE FROM grids.tables WHERE base_id = ${fixture.baseId}::uuid`;
  await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
  if (fixture.accessId) await sql`DELETE FROM auth.access WHERE id = ${fixture.accessId}::uuid`;
  await sql`DELETE FROM auth.users WHERE id IN (${fixture.readerId}::uuid, ${fixture.strangerId}::uuid)`;
});

describe("a table's new records per day", () => {
  postgresTest("count the live records of the table by the viewer's calendar days, in one statement", async () => {
    const meter = await meterSql();
    let berlin: Awaited<ReturnType<typeof getRecordCreatedSeries>> | undefined;
    try {
      const statements = await meter.during(async () => {
        berlin = await getRecordCreatedSeries(fixture.tableId, { days: 7, timeZone: "Europe/Berlin", now: NOW });
      });
      expect(statements).toHaveLength(1);
    } finally {
      await meter.close();
    }
    expect(berlin?.total).toBe(4);
    expect(berlin?.points).toEqual([
      { day: "2026-10-20", created: 1 },
      { day: "2026-10-21", created: 0 },
      { day: "2026-10-22", created: 0 },
      { day: "2026-10-23", created: 0 },
      { day: "2026-10-24", created: 0 },
      { day: "2026-10-25", created: 0 },
      { day: "2026-10-26", created: 2 },
    ]);
    const utc = await getRecordCreatedSeries(fixture.tableId, { days: 7, timeZone: "UTC", now: NOW });
    expect(utc.points.slice(-2)).toEqual([
      { day: "2026-10-25", created: 1 },
      { day: "2026-10-26", created: 1 },
    ]);
  });

  postgresTest("are bounded to 90 days and answer for a zone only Intl knows", async () => {
    const long = await getRecordCreatedSeries(fixture.tableId, { days: 500, timeZone: "Europe/Berlin", now: NOW });
    expect(long.points).toHaveLength(RECORD_SERIES_DAYS.max);
    expect(long.points.reduce((sum, point) => sum + point.created, 0)).toBe(4);
    const meter = await meterSql();
    try {
      // Postgres refuses this old link; the series falls back to UTC days with a second statement
      const statements = await meter.during(async () => {
        const series = await getRecordCreatedSeries(fixture.tableId, { days: 7, timeZone: "US/Pacific-New", now: NOW });
        expect(series.points).toHaveLength(7);
      });
      expect(statements.length).toBeLessThanOrEqual(2);
    } finally {
      await meter.close();
    }
  });

  postgresTest("answer a reader of the base, not a stranger, and only for a stored table", async () => {
    const path = (tablePublicId: string) => `/by-table/${tablePublicId}/created-series?days=7`;
    const ok = await api(fixture.readerId).request(path(fixture.tablePublicId));
    expect(ok.status).toBe(200);
    const series = PublicRecordCreatedSeriesSchema.parse(await ok.json());
    expect(series.total).toBe(4);
    expect(series.points).toHaveLength(7);

    const stranger = await api(fixture.strangerId).request(path(fixture.tablePublicId));
    expect(stranger.status).toBe(403);
    expect(await stranger.text()).not.toContain('"total"');

    const combined = await api(fixture.readerId).request(path(fixture.combinedTablePublicId));
    expect(combined.status).toBe(400);
    expect((await api(fixture.readerId).request(`/by-table/${fixture.tablePublicId}/created-series?days=91`)).status).toBe(400);
  });
});
