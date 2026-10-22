import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { dashboardCapabilities } from "../dashboard-capabilities";
import { DashboardDefinitionSchema } from "../dashboard-contracts";
import { migrate } from "../migrate";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { seedActiveBaseStore } from "./base-store.test-fixture";
import { createDashboardPanels, readPublicDashboard } from "./dashboard-panels";
import { createDashboardRuns } from "./dashboard-runs";
import { dashboards, findDashboard } from "./dashboards";
import type { SqlResult } from "./sql-service";

suiteFor("database")("SQL dashboard permissions, publication and durable runs", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  const baseId = "adc6054d-5b1c-4f1f-986c-1c472daff803";
  const userId = "bdc6054d-5b1c-4f1f-986c-1c472daff803";
  const identity = { ...adminFixtureIdentity(userId, false), baseId };
  const definition = DashboardDefinitionSchema.parse({
    panels: [{ id: "visits", title: "Visits", kind: "number", sql: "SELECT 42 AS visits, 'hidden' AS extra", columns: ["visits"] }],
  });
  beforeAll(async () => {
    database = await useFreshDatabase("pulse_dashboards");
    const { runCoreSetup } = await import("../../../core/src/runtime-helpers");
    await runCoreSetup();
    await migrate("UTC");
    await sql`INSERT INTO auth.users(id,uid,provider,profile,display_name) VALUES(${userId}::uuid,'dashboard-user','local','user','Dashboard fixture')`;
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,'Dash01','Dashboard base')`;
    await seedActiveBaseStore(baseId);
    const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${userId}::uuid,'write') RETURNING id`;
    await sql`INSERT INTO pulse.base_access VALUES(${baseId}::uuid,${access!.id}::uuid)`;
  }, 30_000);
  afterAll(async () => {
    await sql.close();
    await database?.drop();
  });
  const save = async (name: string) => {
    const result = await dashboards.save({ ...identity, name, definition, idempotencyKey: name });
    if (!result.ok) throw new Error(result.error.message);
    const row = await findDashboard(baseId, result.data.id);
    if (!row) throw new Error("Missing dashboard");
    return { dashboard: result.data, row };
  };
  test("readers cannot mutate; idempotency and revision fences hold; exposure edits revoke public access", async () => {
    const saved = await save("Publication");
    expect(await dashboards.save({ ...identity, name: "Publication", definition, idempotencyKey: "Publication" })).toMatchObject({
      ok: true,
      data: saved.dashboard,
    });
    expect(await dashboards.save({ ...identity, name: "Different", definition, idempotencyKey: "Publication" })).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
    await sql`UPDATE auth.access SET permission='read' WHERE user_id=${userId}::uuid`;
    expect(await dashboards.get({ ...identity, dashboardId: saved.dashboard.id })).toMatchObject({ ok: true });
    expect(await dashboards.save({ ...identity, name: "Denied", definition })).toMatchObject({ ok: false, error: { status: 403 } });
    await sql`UPDATE auth.access SET permission='write' WHERE user_id=${userId}::uuid`;
    const input = {
      ...identity,
      dashboardId: saved.dashboard.id,
      expectedRevision: 1,
      columns: { visits: ["visits"] },
      idempotencyKey: "publish-1",
    };
    expect(await dashboards.publish({ ...input, columns: { visits: ["extra"] } })).toMatchObject({ ok: false, error: { status: 400 } });
    const publication = await dashboards.publish(input);
    if (!publication.ok) throw new Error(publication.error.message);
    expect(await dashboards.publish(input)).toEqual(publication);
    const token = publication.data.href.split("/").at(-1)!;
    const publicData = await readPublicDashboard(token);
    expect(publicData).toMatchObject({ ok: true, data: { panels: [{ columns: ["visits"] }] } });
    expect(JSON.stringify(publicData)).not.toContain("hidden");
    const receipts = await sql<{ response: string }[]>`SELECT response FROM pulse.dashboard_operations WHERE base_id=${baseId}::uuid`;
    expect(receipts.some((r) => r.response.includes(token))).toBe(false);
    const titleEdit = { panels: definition.panels.map((panel) => ({ ...panel, title: "Website visits", width: "full" as const })) };
    expect(
      await dashboards.save({
        ...identity,
        dashboardId: saved.dashboard.id,
        expectedRevision: 2,
        name: "New title",
        definition: titleEdit,
      }),
    ).toMatchObject({ ok: true, data: { published: true, revision: 3 } });
    expect(await readPublicDashboard(token)).toMatchObject({ ok: true });
    expect(
      await dashboards.save({ ...identity, dashboardId: saved.dashboard.id, expectedRevision: 2, name: "Stale", definition }),
    ).toMatchObject({ ok: false, error: { status: 409 } });
    const changed = { panels: definition.panels.map((p) => ({ ...p, sql: "SELECT 43 AS visits" })) };
    expect(
      await dashboards.save({ ...identity, dashboardId: saved.dashboard.id, expectedRevision: 3, name: "New title", definition: changed }),
    ).toMatchObject({ ok: true, data: { published: false, revision: 4 } });
    expect(await readPublicDashboard(token)).toMatchObject({ ok: false, error: { status: 404 } });
  });
  test("ordinary saves can be remembered but public output changes and publishing require fresh approval", async () => {
    const { dashboard } = await save("Approval");
    const context: import("@k2b/cloud/contracts").CapabilityExecutionContext = {
      ...identity,
      user: null,
      locale: "de",
      requestId: "dashboard-review",
      origin: "assistant",
      signal: new AbortController().signal,
      idempotencyKey: "dashboard-review",
    };
    const review = dashboardCapabilities.actions["dashboard.save"].review;
    const draft = { baseId, dashboardId: dashboard.id, expectedRevision: 1, name: dashboard.name, definition };
    expect(await review(draft, context)).toMatchObject({ ok: true, data: { scope: expect.any(String) } });
    const publication = await dashboards.publish({
      ...identity,
      dashboardId: dashboard.id,
      expectedRevision: 1,
      columns: { visits: ["visits"] },
    });
    expect(publication.ok).toBe(true);
    const same = await review({ ...draft, expectedRevision: 2 }, context);
    expect(same).toMatchObject({ ok: true, data: { scope: expect.any(String) } });
    const changed = await review(
      { ...draft, expectedRevision: 2, definition: { panels: definition.panels.map((p) => ({ ...p, sql: "SELECT 43 AS visits" })) } },
      context,
    );
    expect(changed.ok).toBe(true);
    if (!changed.ok) throw new Error(changed.error.message);
    expect(changed.data).toMatchObject({ ask: "changes_access" });
    expect(changed.data).toMatchObject({ consequences: [{ text: "Der bisherige öffentliche Link endet." }] });
    const publicationReview = await dashboardCapabilities.actions["dashboard.publish"].review(
      { baseId, dashboardId: dashboard.id, expectedRevision: 2, columns: { visits: ["visits"] } },
      context,
    );
    expect(publicationReview.ok).toBe(true);
    if (!publicationReview.ok) throw new Error(publicationReview.error.message);
    const { assertCapabilityReview, assertResourceOpenLink } = await import("@k2b/cloud/capabilities/testing");
    assertCapabilityReview(publicationReview.data, { policy: { ask: "changes_access" }, queries: [], validateQueryInput: () => false });
    assertCapabilityReview(changed.data, { policy: { silent: "shared" }, queries: [], validateQueryInput: () => false });
    expect(publicationReview.data).toMatchObject({ content: { kind: "page", baseRevision: 2, body: expect.stringContaining('"visits"') } });
    const read = dashboardCapabilities.queries["dashboard.read"];
    const resource = await read.run({ id: dashboard.id }, context);
    expect(resource).toMatchObject({ ok: true, data: { data: { id: dashboard.id, baseId: "Dash01" } } });
    if (!resource.ok) throw new Error(resource.error.message);
    assertResourceOpenLink(resource.data);
    expect(dashboardCapabilities.actions["dashboard.publish"].destructive).toBe(true);
    expect("approval" in dashboardCapabilities.actions["dashboard.publish"]).toBe(false);
    expect(await review(draft, context)).toMatchObject({ ok: false, error: { status: 409 } });
  });
  test("replicas share one receipt per interval; crashes and errors back off; obsolete completions are fenced", async () => {
    const { row } = await save("Receipts");
    let at = new Date("2026-10-22T12:00:00Z");
    const a = createDashboardRuns({ now: () => at }),
      b = createDashboardRuns({ now: () => at });
    const claims = await Promise.all([a.claim(row.id, "range"), b.claim(row.id, "range")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(Boolean)!;
    expect(await a.finish(row.id, "range", first.leaseId, null)).toBe(true);
    expect(await b.claim(row.id, "range")).toBeNull();
    at = new Date("2026-10-22T12:01:00Z");
    const failed = (await b.claim(row.id, "range"))!;
    expect(await b.finish(row.id, "range", failed.leaseId, "BUSY")).toBe(true);
    expect((await a.read(row.id, "range"))?.retry_at?.toISOString()).toBe("2026-10-22T12:02:00.000Z");
    at = new Date("2026-10-22T12:02:00Z");
    const crashed = (await a.claim(row.id, "range"))!;
    at = new Date("2026-10-22T12:03:00Z");
    expect(await b.claim(row.id, "range")).toBeNull();
    expect((await a.read(row.id, "range"))?.retry_at?.toISOString()).toBe("2026-10-22T12:05:00.000Z");
    expect(await a.finish(row.id, "range", crashed.leaseId, null)).toBe(false);
    at = new Date("2026-10-22T12:05:00Z");
    expect(await b.claim(row.id, "range")).not.toBeNull();
  });
  test("cache loss does not refund execution; last-good is projected and retained during errors; access and reset fences apply", async () => {
    const { dashboard } = await save("Panel execution");
    let at = new Date("2026-10-22T13:00:00Z"),
      calls = 0,
      fail = false,
      clear = false;
    const snapshots = new Map<string, import("./dashboard-cache").DashboardSnapshot>();
    const cache = {
      close() {},
      read: async (key: string) => snapshots.get(key) ?? null,
      put: async (key: string, value: import("./dashboard-cache").DashboardSnapshot) => {
        snapshots.set(key, value);
        return true;
      },
    };
    const result: SqlResult = {
      columns: [
        { name: "visits", type: "UInt64" },
        { name: "extra", type: "String" },
      ],
      rows: [[42, "hidden"]],
      rowCount: 1,
      truncated: false,
      stats: { elapsedMs: 1, readRows: 1, readBytes: 1 },
      runId: "fixture",
      limits: {
        profile: "small",
        memoryBytes: 1,
        timeSeconds: 10,
        maxRows: 10000,
        maxResultBytes: 4194304,
        queriesUsed: 0,
        queriesPerHour: 600,
        resetAt: "2026-10-22T14:00:00Z",
        baseSlots: 1,
        cloudSlots: 3,
        maxWaiting: 20,
        waitMs: 5000,
      },
    };
    const read = createDashboardPanels({
      cache,
      runs: createDashboardRuns({ now: () => at }),
      now: () => at,
      privateRun: async () => {
        calls++;
        if (clear) await sql`UPDATE pulse.base_stores SET reset_generation=reset_generation+1 WHERE base_id=${baseId}::uuid`;
        return fail ? { ok: false, error: { code: "STORE_UNAVAILABLE", message: "Unavailable", status: 503 } } : { ok: true, data: result };
      },
    });
    const input = { identity, baseId, dashboardId: dashboard.id, panelId: "visits", range: {} };
    expect(await read(input)).toMatchObject({ ok: true, data: { status: "ready", lastGood: { data: { rows: [[42]] } } } });
    snapshots.clear();
    expect(await read(input)).toMatchObject({ ok: true, data: { status: "waiting", lastGood: null } });
    expect(calls).toBe(1);
    at = new Date("2026-10-22T13:01:00Z");
    await read(input);
    const originalRead = cache.read;
    let reads = 0;
    cache.read = async (key) => (++reads === 1 ? null : originalRead(key));
    expect(await read(input)).toMatchObject({ ok: true, data: { status: "ready", lastGood: { data: { rows: [[42]] } } } });
    expect(calls).toBe(2);
    cache.read = originalRead;
    fail = true;
    at = new Date("2026-10-22T13:02:00Z");
    expect(await read(input)).toMatchObject({ ok: true, data: { status: "error", lastGood: { data: { rows: [[42]] } } } });
    expect(calls).toBe(3);
    await read({ ...input, range: { range: "24h", from: "2026-10-20T00:00:10Z", to: "2026-10-21T00:00:10Z" } });
    await read({ ...input, range: { range: "90d", from: "2026-10-20T00:00:20Z", to: "2026-10-21T00:00:20Z" } });
    expect(calls).toBe(4); // Same effective custom window shares the failure/backoff receipt.
    await sql`DELETE FROM pulse.base_access WHERE base_id=${baseId}::uuid`;
    expect(await read(input)).toMatchObject({ ok: false, error: { status: 404 } });
    const [grant] = await sql<{ id: string }[]>`SELECT id FROM auth.access WHERE user_id=${userId}::uuid`;
    await sql`INSERT INTO pulse.base_access VALUES(${baseId}::uuid,${grant!.id}::uuid)`;
    at = new Date("2026-10-22T13:03:00Z");
    fail = false;
    clear = true;
    expect(await read(input)).toMatchObject({ ok: false, error: { status: 404 } });
  });
});
