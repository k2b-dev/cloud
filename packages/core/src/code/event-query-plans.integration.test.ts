import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAppEvents } from "../migrate/core/app-events";
import { migrate as migrateAuth } from "../migrate/core/auth";

type PlanRows = {
  "QUERY PLAN": [
    {
      Plan: { "Node Type": string; "Actual Rows": number; "Shared Hit Blocks": number };
      "Execution Time": number;
    },
  ];
}[];

const count = 12_000;
const person = "00000000-0000-4000-8000-000000000001";
const mandateId = "00000000-0000-4000-8000-000000000043";
const place = { type: "app3.place", id: "place-43" };
const binding = {
  consumer: "core.code",
  key: "code-43",
  revision: "registration-43",
  mandateId,
  mandateOwnerAppId: "runner",
  mandateRevision: 1,
  place,
};

// Keep these predicates aligned with accept.ts and event-catchup.ts. Do not disable sequential scans:
// the planner must choose the indexes using ordinary statistics and realistic cardinalities.
const fanout = (placeType: string | null, placeId: string | null) => sql<PlanRows>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
  SELECT id FROM events.app_subscriptions
  WHERE event_type='app3.changed1' AND version=2 AND state='active'
    AND (resource_binding IS NULL OR (resource_binding IS NOT NULL
      AND resource_binding->'place'->>'type'=${placeType} AND resource_binding->'place'->>'id'=${placeId}
      AND first_seen_at<='2026-11-01T12:00:00Z'::timestamptz))`;
const lookup = () => sql<PlanRows>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
  SELECT id,resource_binding FROM events.app_subscriptions
  WHERE resource_binding IS NOT NULL AND state='active' AND event_type='app3.changed1' AND version=2
    AND resource_binding->>'consumer'='core.code' AND resource_binding->>'key'='code-43'
    AND resource_binding->'place'=${JSON.stringify(place)}::text::jsonb`;
const execution = (targeted: boolean) => sql<PlanRows>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
  SELECT mandate.id FROM auth.mandates mandate
  JOIN events.app_subscriptions subscription ON subscription.resource_binding->>'mandateId'=mandate.id::text
  WHERE ${targeted ? sql`subscription.id='subscription-43' AND mandate.id=${mandateId}::uuid` : sql`true`}
    AND mandate.owner_app_id='runner' AND mandate.workload_type='code.version' AND mandate.workload_id='version-43'
    AND mandate.subject_kind='user' AND COALESCE(mandate.subject_user_id,mandate.subject_service_account_id)=${person}::uuid
    AND mandate.state='active' AND mandate.confirmed_at IS NOT NULL
    AND (mandate.expires_at IS NULL OR mandate.expires_at>clock_timestamp())
    AND mandate.revision=(subscription.resource_binding->>'mandateRevision')::int
    AND subscription.state='active' AND subscription.resource_binding=${JSON.stringify(binding)}::text::jsonb
    AND subscription.event_type='app3.changed1' AND subscription.version=2
  FOR SHARE OF mandate,subscription`;

suiteFor("database")("subscription query plans at R1 scale", () => {
  let emptyMigrationMs = 0;
  let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;
  beforeAll(async () => {
    database = await useFreshDatabase("code_event_plans");
    await migrateAuth();
    await sql`CREATE SCHEMA events`.simple();
    const start = performance.now();
    await migrateAppEvents();
    emptyMigrationMs = performance.now() - start;
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${person}::uuid,'plan-owner','local','user')`;
    await sql`INSERT INTO auth.mandates(id,subject_kind,subject_user_id,owner_app_id,workload_type,workload_id,policy)
      SELECT ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'user',${person}::uuid,
        'runner','code.version','version-' || i,'{"version":1}'::jsonb FROM generate_series(1,${count}) i`;
    await sql`INSERT INTO events.app_subscriptions(id,app_id,event_type,version,state,resource_binding,first_seen_at)
      SELECT 'subscription-' || i,'app' || i%4,'app' || i%4 || '.changed' || i%3,1+i%2,
        CASE WHEN i%10=0 THEN 'blocked' ELSE 'active' END,
        jsonb_build_object('consumer','core.code','key','code-' || i,'revision','registration-' || i,
          'mandateId','00000000-0000-4000-8000-' || lpad(i::text,12,'0'),'mandateOwnerAppId','runner','mandateRevision',1,
          'place',jsonb_build_object('type','app' || i%4 || '.place','id','place-' || i%100)),
        '2026-11-01T00:00:00Z'::timestamptz FROM generate_series(1,${count}) i`;
    await sql`INSERT INTO events.app_subscriptions(id,app_id,event_type,version,state,first_seen_at)
      SELECT 'service-' || i,'subscriber' || i,'app' || i%4 || '.changed' || i%3,1+i%2,'active',
        '2026-11-01T00:00:00Z'::timestamptz FROM generate_series(1,40) i`;
    await sql`ANALYZE events.app_subscriptions`.simple();
    await sql`ANALYZE auth.mandates`.simple();
  }, 30_000);
  afterAll(async () => {
    if (database) {
      await sql.close();
      await database.drop();
    }
  });

  test("fan-out and both catch-up lookups use indexes; report a small before/after probe", async () => {
    // Simulate upgrading an already populated pre-index installation, then repeat migration for idempotence.
    await sql`DROP INDEX IF EXISTS events.app_subscriptions_fanout_service,events.app_subscriptions_fanout_resource`.simple();
    const beforeFanout = await fanout(place.type, place.id);
    const beforeCatchup = await execution(false);
    expect(JSON.stringify(beforeFanout)).toContain('"Seq Scan"');
    expect(JSON.stringify(beforeCatchup)).toContain('"Seq Scan"');
    const start = performance.now();
    await migrateAppEvents();
    const upgradeMs = performance.now() - start;
    await migrateAppEvents();
    const afterFanout = await fanout(place.type, place.id);
    const serviceFanout = await fanout(null, null);
    const afterLookup = await lookup();
    const afterCatchup = await execution(true);
    for (const plan of [afterFanout, serviceFanout, afterLookup, afterCatchup]) {
      expect(JSON.stringify(plan)).not.toContain('"Seq Scan"');
      expect(JSON.stringify(plan)).toContain("Index");
    }
    expect(JSON.stringify(afterFanout)).toContain("app_subscriptions_fanout_service");
    expect(JSON.stringify(afterFanout)).toContain("app_subscriptions_fanout_resource");
    expect(JSON.stringify(afterLookup)).toContain("app_subscriptions_resource");
    expect(JSON.stringify(afterCatchup)).toContain("app_subscriptions_pkey");
    expect(JSON.stringify(afterCatchup)).toContain(mandateId);
    const details = (rows: PlanRows) => {
      const result = rows[0]?.["QUERY PLAN"][0];
      if (!result) throw new Error("EXPLAIN returned no query plan");
      return result;
    };
    for (const [plan, rows] of [
      [afterFanout, 43],
      [serviceFanout, 3],
      [afterLookup, 1],
      [afterCatchup, 1],
    ] as const)
      expect(details(plan).Plan["Actual Rows"]).toBe(rows);
    // Report plan shape, rows, buffers and execution time, without a noisy full EXPLAIN dump.
    const summary = (plan: PlanRows) => {
      const result = details(plan);
      return {
        node: result.Plan["Node Type"],
        rows: result.Plan["Actual Rows"],
        sharedHits: result.Plan["Shared Hit Blocks"],
        executionMs: result["Execution Time"],
      };
    };
    console.log(
      JSON.stringify({
        subscriptions: count + 40,
        emptyMigrationMs,
        upgradeMs,
        beforeFanout: summary(beforeFanout),
        afterFanout: summary(afterFanout),
        beforeCatchup: summary(beforeCatchup),
        afterCatchup: summary(afterCatchup),
      }),
    );
  });
});
