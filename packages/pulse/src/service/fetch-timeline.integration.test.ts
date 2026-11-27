import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { accessScopeFor } from "./access-control";
import { sourceHour } from "./fetch-timeline";
import { sourceAlerts } from "./source-alerts";
import { listSources, sourceFigures } from "./source-management";

// 10:42 in Berlin; the base's day began at 23:00 UTC the evening before
const NOW = new Date("2026-11-25T09:42:00.000Z");

suiteFor("database", "valkey")("Pulse fetch timeline", () => {
  let memberId: string, baseId: string, otherBaseId: string, accessId: string, sourceId: string;
  beforeAll(async () => {
    const [person] = await sql<{ id: string }[]>`
      INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`fetch-member-${crypto.randomUUID()}`}, 'local', 'user', 'Fetch member') RETURNING id`;
    memberId = person!.id;
    const bases = await sql<{ id: string }[]>`
      INSERT INTO pulse.bases(short_id, name, timezone)
      VALUES (${newShortId()}, 'Fetch fixture', 'Europe/Berlin'), (${newShortId()}, 'Other fixture', 'Europe/Berlin')
      RETURNING id`;
    [baseId, otherBaseId] = bases.map((base) => base.id) as [string, string];
    const [grant] = await sql<{ id: string }[]>`
      INSERT INTO auth.access(user_id, permission) VALUES (${memberId}::uuid, 'read') RETURNING id`;
    accessId = grant!.id;
    await sql`INSERT INTO pulse.base_access(base_id, access_id) VALUES (${baseId}::uuid, ${accessId}::uuid)`;
    const sources = await sql<{ id: string }[]>`
      INSERT INTO pulse.sources(short_id, base_id, kind, name)
      VALUES (${newShortId()}, ${baseId}::uuid, 'metrics', 'Server'),
             (${newShortId()}, ${baseId}::uuid, 'http_ingest', 'Shop'),
             (${newShortId()}, ${otherBaseId}::uuid, 'metrics', 'Elsewhere')
      RETURNING id`;
    sourceId = sources[0]!.id;
    const elsewhere = sources[2]!.id;
    // a fine minute just now, a minute with one failure and one success, one 21 minutes ago, one at 10:00 (outside
    // the 30 minutes, inside today), one yesterday evening in Berlin, and another base's fetch
    for (const [source, base, at, success] of [
      [sourceId, baseId, "2026-11-25T09:41:30Z", true],
      [sourceId, baseId, "2026-11-25T09:40:30Z", false],
      [sourceId, baseId, "2026-11-25T09:40:45Z", true],
      [sourceId, baseId, "2026-11-25T09:20:30Z", true],
      [sourceId, baseId, "2026-11-25T09:00:00Z", true],
      [sourceId, baseId, "2026-11-24T22:30:00Z", true],
      [elsewhere, otherBaseId, "2026-11-25T09:41:00Z", false],
    ] as const)
      await sql`INSERT INTO pulse.source_scrapes(base_id, source_id, started_at, finished_at, duration_ms, success, metrics_count)
        VALUES (${base}::uuid, ${source}::uuid, ${at}::timestamptz, ${at}::timestamptz + interval '1 second', 600, ${success},
          ${success ? 86 : 0})`;
  });
  afterAll(async () => {
    for (const id of [baseId, otherBaseId]) if (id) await sql`DELETE FROM pulse.bases WHERE id=${id}::uuid`;
    if (accessId) await sql`DELETE FROM auth.access WHERE id=${accessId}::uuid`;
    if (memberId) await sql`DELETE FROM auth.users WHERE id=${memberId}::uuid`;
  });
  const scope = () => {
    const identity = adminFixtureIdentity(memberId, false);
    const result = accessScopeFor(identity.actor, identity.accessSubject);
    if (!result.ok) throw new Error("Missing access scope");
    return result.data;
  };

  test("a metrics source in the list carries its last 30 minutes, one slot per minute; a push source none", async () => {
    const list = await listSources(baseId, scope(), { now: NOW });
    if (!list.ok) throw new Error("The list is not readable");
    const server = list.data.find((source) => source.name === "Server");
    const shop = list.data.find((source) => source.name === "Shop");
    expect(server?.fetches).toHaveLength(30);
    expect(server?.fetches?.[29]).toBe("ok");
    expect(server?.fetches?.[28]).toBe("bad");
    expect(server?.fetches?.[8]).toBe("ok");
    expect(server?.fetches?.filter((slot) => slot !== "none")).toHaveLength(3);
    expect(shop && "fetches" in shop).toBe(false);
  });

  test("the open source's hour has a minute per slot with the values its fetches brought, and stays closed to others", async () => {
    const hour = await sourceHour({ baseId, sourceId, user: scope(), now: NOW });
    if (!hour.ok) throw new Error("The hour is not readable");
    expect(hour.data).toHaveLength(60);
    expect(hour.data[59]).toEqual({ slot: "ok", values: 86 });
    // a failed and a successful fetch in the same minute: the minute failed, the values still count
    expect(hour.data[58]).toEqual({ slot: "bad", values: 86 });
    // 10:00 lies 42 minutes back
    expect(hour.data[17]).toEqual({ slot: "ok", values: 86 });
    expect(hour.data.filter((minute) => minute.slot !== "none")).toHaveLength(4);
    const otherBase = await sourceHour({ baseId: otherBaseId, sourceId, user: scope(), now: NOW });
    expect(otherBase.ok).toBe(false);
    // a source of another base read through a base the person may read stays unknown
    const [elsewhere] = await sql<{ id: string }[]>`SELECT id FROM pulse.sources WHERE base_id = ${otherBaseId}::uuid`;
    const crossed = await sourceHour({ baseId, sourceId: elsewhere!.id, user: scope(), now: NOW });
    expect(crossed.ok).toBe(false);
  });

  test("an open source lists the alert rules that name it or fire on its target, and no others", async () => {
    await sql`UPDATE pulse.sources SET endpoint_url = 'http://10.0.0.12:9100/metrics' WHERE id = ${sourceId}::uuid`;
    const [server] = await sql<{ short_id: string }[]>`SELECT short_id FROM pulse.sources WHERE id = ${sourceId}::uuid`;
    const rule = async (base: string, name: string, query: string, state = "ok") => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO pulse.alert_rules(short_id, base_id, name, sql, comparison, critical, min_duration_seconds, interval_seconds, state)
        VALUES (${newShortId()}, ${base}::uuid, ${name}, ${query}, 'above', 90, 0, 300, ${state}) RETURNING id`;
      return row!.id;
    };
    // names the source by its id; fires on the source's target; names nothing of it; the id only inside a longer word;
    // another base naming the source
    await rule(baseId, "By id", `SELECT 'x' AS key, 1 AS value FROM series WHERE source_id = '${server!.short_id}'`);
    const byTarget = await rule(baseId, "By target", "SELECT host AS key, avg(value) AS value FROM samples GROUP BY host", "firing");
    await sql`INSERT INTO pulse.alert_states(rule_id, key, state, since, last_checked_at)
      VALUES (${byTarget}::uuid, '10.0.0.12:9100', 'firing', now(), now())`;
    await rule(baseId, "Unrelated", "SELECT 'shop' AS key, 1 AS value");
    await rule(baseId, "Part of a word", `SELECT 'x${server!.short_id}y' AS key, 1 AS value`);
    await rule(otherBaseId, "Other base", `SELECT '${server!.short_id}' AS key, 1 AS value`);
    const alerts = await sourceAlerts({ baseId, sourceId, user: scope() });
    if (!alerts.ok) throw new Error("The alerts are not readable");
    // firing first, then by name
    expect(alerts.data.map((alert) => alert.name)).toEqual(["By target", "By id"]);
    expect(alerts.data[0]).toMatchObject({ state: "firing" });
    expect((await sourceAlerts({ baseId: otherBaseId, sourceId, user: scope() })).ok).toBe(false);
  });

  test("the figures count today's fetches since midnight in the base's zone, in ten-minute buckets", async () => {
    const figures = await sourceFigures(baseId, scope(), NOW);
    if (!figures.ok) throw new Error("The figures are not readable");
    const today = figures.data.fetchesToday;
    expect(today).toMatchObject({ ok: 4, failed: 1 });
    expect(today?.buckets).toHaveLength(65);
    expect(today?.buckets[64]).toEqual({ ok: 2, failed: 1 });
    expect(today?.buckets[62]).toEqual({ ok: 1, failed: 0 });
    expect(today?.buckets[60]).toEqual({ ok: 1, failed: 0 });
  });
});
