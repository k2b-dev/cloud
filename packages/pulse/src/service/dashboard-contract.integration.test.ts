import { expect, test } from "bun:test";
import { err, fail, ok } from "@k2b/cloud/server";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { createDashboard, listDashboards } from "./dashboard-management";
import { getDashboardSnapshot } from "./public-dashboard-snapshot";

const postgresTest = process.env.PULSE_DASHBOARD_DB_TEST === "1" ? test : test.skip;
postgresTest(
  "persists only a JSON object source, renders its compiled query, and exposes refresh failures",
  async () => {
    const baseId = crypto.randomUUID(),
      sourceId = crypto.randomUUID(),
      sourceShortId = newShortId();
    const [user] =
      await sql`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${`pulse-dashboard-${baseId}`},'local','user','Dashboard test') RETURNING id`;
    const [access] = await sql`INSERT INTO auth.access(user_id,permission) VALUES(${user.id}::uuid,'admin') RETURNING id`;
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,${newShortId()},'Dashboard test')`;
    await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${baseId}::uuid,${access.id}::uuid)`;
    await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name) VALUES(${sourceId}::uuid,${sourceShortId},${baseId}::uuid,'http_ingest','Probe')`;
    try {
      const dsl = `dashboard "Ops" {
    controls { range "Window" variable range default 1h options 1h, 6h }
    line "CPU" { query metric cpu avg since $range source ${sourceShortId} }
  }`;
      const created = await createDashboard({ baseId, user: { id: user.id }, name: "Ops", config: { dsl, refreshIntervalSeconds: 5 } });
      expect(created.ok).toBe(true);
      if (!created.ok) throw Error(created.error.message);
      const [stored] = await sql`SELECT config,jsonb_typeof(config) AS type FROM pulse.dashboards WHERE id=${created.data.id}::uuid`;
      expect(stored.type).toBe("object");
      expect(stored.config).toEqual({ dsl, refreshIntervalSeconds: 5 });
      const list = await listDashboards(baseId, { id: user.id });
      expect(list.ok).toBe(true);
      if (list.ok) expect(list.data[0]?.config).toEqual(created.data.config);
      const deps = {
        queryMetricData: async (query: import("../contracts").MetricQuery) => {
          expect(query.sourceId).toBe(sourceId);
          expect(query.since).toBe("1h");
          return ok([{ bucket: "2026-01-01T00:00:00.000Z", value: 0 }]);
        },
        queryEventAggregateData: async () => ok([]),
        queryEventsData: async () => ok([]),
        queryStatesData: async () => ok([]),
        queryEventMapData: async () => ok([]),
      };
      const snapshot = await getDashboardSnapshot(created.data.id, { id: user.id }, deps);
      expect(snapshot.ok).toBe(true);
      if (snapshot.ok) expect(Object.values(snapshot.data.points)[0]?.[0]?.value).toBe(0);
      expect(
        await getDashboardSnapshot(
          created.data.id,
          { id: user.id },
          { ...deps, queryMetricData: async () => fail(err.badInput("Query budget exceeded")) },
        ),
      ).toMatchObject({ ok: false, error: { message: "Query budget exceeded" } });
      await sql`DELETE FROM pulse.sources WHERE id=${sourceId}::uuid`;
      expect(await getDashboardSnapshot(created.data.id, { id: user.id }, deps)).toMatchObject({
        ok: false,
        error: { message: "Dashboard references an unavailable source" },
      });
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id=${access.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user.id}::uuid`;
    }
  },
  30000,
);
