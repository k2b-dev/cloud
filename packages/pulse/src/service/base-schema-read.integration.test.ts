import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { createTestAppSession } from "@k2b/cloud/services/session/session.test-fixture";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { clickhouseAdminQuery as admin } from "../../../../scripts/fixtures/test-clickhouse";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import pulseApi from "../api";
import { schemaReadQuery } from "../capabilities-schema";
import { BaseSchemaReadSchema } from "../schema-contracts";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { baseStore } from "../store/base-store";
import { cleanupFixtureBase, fixtureBase, fixtureConnection, fixtureStore, installFixtureStore } from "../store/base-store.test-fixture";
import { settingsFixture } from "../store/settings.test-fixture";
import { quoteIdentifier as q } from "../store/validation";
import { createBaseLifecycle } from "./base-lifecycle";
import { readBaseSchema } from "./base-schema-read";
import { sqlAdmission } from "./sql-admission";

const app = new Hono().route("/api/pulse", pulseApi);
const suite = suiteFor("database", "clickhouse", "valkey", "nats");
const CONFIDENTIAL = ["secret_email", "leak@example.test", "PAYLOAD_MARKER"];

suite("Pulse data catalog reads only the base read views", () => {
  let settings: ReturnType<typeof settingsFixture>;
  let credentials: ReturnType<typeof spyOn<typeof baseStore, "readUserCredentials">>;
  const store = fixtureStore();
  beforeAll(async () => {
    settings = settingsFixture();
    settings.values["pulse.clickhouse_connection"] = JSON.stringify(fixtureConnection());
    await installFixtureStore();
    // Credentials still come from the real encrypted PG record; runner, admission and grants are real.
    credentials = spyOn(baseStore, "readUserCredentials").mockImplementation((baseId) => store.readUserCredentials(baseId));
  }, 30_000);
  afterAll(() => {
    credentials?.mockRestore();
    settings?.restore();
    sqlAdmission.close();
  });

  test("catalog, fields, named entries and access agree across service, capability and HTTP", async () => {
    const base = await fixtureBase(),
      other = await fixtureBase();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES(${`pulse-schema-${base.id}`},'local','user','Pulse schema reader') RETURNING id`;
    const [stranger] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES(${`pulse-schema-stranger-${base.id}`},'local','user','Pulse schema stranger') RETURNING id`;
    try {
      await createBaseLifecycle(store)(base.id);
      const [grant] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access(user_id,permission) VALUES(${user!.id}::uuid,'read') RETURNING id`;
      await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${base.id}::uuid,${grant!.id}::uuid)`;

      // Control plane: the registry the catalog lists.
      const seen = "2026-10-17T11:00:00.000Z";
      const [metric] = await sql<{ id: string }[]>`INSERT INTO pulse.metric_defs(base_id,name,type,unit)
        VALUES(${base.id}::uuid,'cpu_usage','gauge','percent') RETURNING id::text AS id`;
      const [series] = await sql<{ id: string }[]>`INSERT INTO pulse.metric_series(base_id,metric_id,series_key,dimensions,last_sample_at)
        VALUES(${base.id}::uuid,${metric!.id}::uuid,'host=a','{"host":"a"}'::jsonb,${seen}) RETURNING id::text AS id`;
      await sql`INSERT INTO pulse.event_kinds(base_id,kind,first_seen_at,last_seen_at) VALUES
        (${base.id}::uuid,'order.created',${seen},${seen}),(${base.id}::uuid,'quiet','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`;
      await sql`INSERT INTO pulse.state_keys(base_id,state_key,first_seen_at) VALUES(${base.id}::uuid,'door',${seen})`;
      await sql`INSERT INTO pulse.state_variants(base_id,state_key,variant_key,updated_at,value_hash,version)
        VALUES(${base.id}::uuid,'door','front',${seen},'fixture',1)`;

      // Data plane: one event carries confidential data and a payload that no read may return.
      const db = q(base.database);
      await admin(`INSERT INTO ${db}._events(id,ts,kind,dimensions,attributes,sensitive,payload,version) VALUES
        (generateUUIDv4(),toDateTime64('2026-10-17 10:00:00.000',3,'UTC'),'order.created','{"region":"eu"}','{"amount":12.5,"currency":"EUR","paid":true}','{"secret_email":"leak@example.test"}','{"private":"PAYLOAD_MARKER"}',1),
        (generateUUIDv4(),toDateTime64('2026-10-17 10:30:00.000',3,'UTC'),'order.created','{}','{"amount":3,"note":null}','','',1)`);
      await admin(`INSERT INTO ${db}._series(series_id,metric,type,unit,source_id,resource_key,resource_type,resource_id,dimensions,version)
        VALUES(toUUID('${series!.id}'),'cpu_usage','gauge','percent',NULL,'','','','{"host":"a"}',1)`);
      await admin(`INSERT INTO ${db}._samples(row_id,series_id,ts,value,version)
        VALUES(generateUUIDv4(),toUUID('${series!.id}'),toDateTime64('2026-10-17 10:59:00.000',3,'UTC'),42.5,1)`);
      await admin(`INSERT INTO ${db}._states_current(state_key,variant_key,value,dimensions,resource_key,source_id,updated_at,version)
        VALUES('door','front','"open"','{}','',NULL,toDateTime64('2026-10-17 11:00:00.000',3,'UTC'),1)`);

      const reader = adminFixtureIdentity(user!.id, false);
      const clean = (value: unknown) => {
        const text = JSON.stringify(value);
        for (const marker of [...CONFIDENTIAL, base.database, base.readUser]) expect(text).not.toContain(marker);
      };

      const overview = await readBaseSchema({ ...reader, baseId: base.shortId });
      if (!overview.ok) throw new Error(`OVERVIEW_FAILED: ${overview.error.code} ${overview.error.message}`);
      expect(BaseSchemaReadSchema.parse(overview.data)).toEqual(overview.data);
      clean(overview);
      expect(overview.data).toMatchObject({ baseId: base.shortId, kind: null, truncated: false });
      expect(overview.data.metrics).toEqual({
        total: 1,
        items: [
          {
            name: "cpu_usage",
            type: "gauge",
            unit: "percent",
            seriesCount: 1,
            lastSampleAt: seen,
            dimensions: [{ key: "host", values: 1 }],
            samples: null,
          },
        ],
      });
      const [order, quiet] = overview.data.events.items;
      expect(order).toMatchObject({ kind: "order.created", sampledRows: 2, fieldsTruncated: false, samples: null });
      expect(order!.fields).toEqual([
        { key: "amount", type: "number", types: ["number"], present: 2, fillRate: 1 },
        { key: "currency", type: "string", types: ["string"], present: 1, fillRate: 0.5 },
        { key: "note", type: "null", types: ["null"], present: 1, fillRate: 0.5 },
        { key: "paid", type: "boolean", types: ["boolean"], present: 1, fillRate: 0.5 },
      ]);
      // Older than the sampling window of the newest kind: listed, never invented.
      expect(quiet).toMatchObject({ kind: "quiet", sampledRows: 0, fields: null });
      expect(overview.data.states.items).toEqual([{ key: "door", firstSeenAt: seen, variantCount: 1, updatedAt: seen, samples: null }]);

      // The internal id reaches the same base and the same answer.
      const again = await readBaseSchema({ ...reader, baseId: base.id });
      expect(again.ok && { ...again.data, generatedAt: "" }).toEqual({ ...overview.data, generatedAt: "" });

      const events = await readBaseSchema({ ...reader, baseId: base.shortId, kind: "order.created" });
      if (!events.ok) throw new Error(`EVENTS_FAILED: ${events.error.code}`);
      clean(events);
      expect(events.data.metrics.items).toEqual([]);
      expect(events.data.events.items[0]!.samples).toMatchObject([
        { ts: "2026-10-17T10:30:00.000Z", attributes: { amount: 3, note: null }, dimensions: {}, attributesTruncated: false },
        { ts: "2026-10-17T10:00:00.000Z", attributes: { amount: 12.5, currency: "EUR", paid: true }, dimensions: { region: "eu" } },
      ]);

      const metricRead = await readBaseSchema({ ...reader, baseId: base.shortId, kind: "cpu_usage" });
      expect(metricRead).toMatchObject({
        ok: true,
        data: { metrics: { items: [{ samples: [{ ts: "2026-10-17T10:59:00.000Z", value: 42.5, dimensions: { host: "a" } }] }] } },
      });

      const context: CapabilityExecutionContext = {
        ...reader,
        user: null,
        locale: "en",
        requestId: "pulse-schema-fixture",
        target: { type: "pulse.base", id: base.shortId },
        origin: "http",
        signal: new AbortController().signal,
      };
      const stateRead = await schemaReadQuery.run({ kind: "door" }, context);
      expect(stateRead).toMatchObject({
        ok: true,
        data: { data: { states: { items: [{ key: "door", samples: [{ variantKey: "front", value: "open", valueTruncated: false }] }] } } },
      });

      // Equal refusals for a base without a grant, an unknown base and a reader without access.
      for (const denied of [
        await schemaReadQuery.run({}, { ...context, target: { type: "pulse.base", id: other.shortId } }),
        await schemaReadQuery.run({}, { ...context, target: undefined }),
        await schemaReadQuery.run({}, { ...context, ...adminFixtureIdentity(stranger!.id, false) }),
      ])
        expect(denied).toMatchObject({ ok: false, error: { code: "NO_READ_ACCESS", status: 403 } });

      const { token } = await createTestAppSession(user!.id);
      const request = (path: string) =>
        app.request(`/api/pulse/bases/${path}`, {
          headers: { cookie: `pwa_session=${token}`, "x-forwarded-for": uniqueCallerAddress() },
        });
      const http = await request(`${base.shortId}/schema`);
      expect(http.status).toBe(200);
      const body: unknown = await http.json();
      clean(body);
      expect(BaseSchemaReadSchema.parse(body).events.items[0]!.fields).toEqual(order!.fields);
      expect((await request(`${base.shortId}/schema?kind=${encodeURIComponent("a\nb")}`)).status).toBe(400);
      const refused = await request(`${other.shortId}/schema`);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "NO_READ_ACCESS" });
    } finally {
      await cleanupFixtureBase(base);
      await cleanupFixtureBase(other);
      await sql`DELETE FROM auth.users WHERE id IN (${user!.id}::uuid, ${stranger!.id}::uuid)`;
    }
  }, 120_000);
});
