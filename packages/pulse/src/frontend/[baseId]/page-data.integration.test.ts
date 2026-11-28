import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { AuthContext } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { meterSql } from "../../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { newShortId } from "../../lib/short-id";
import { seedActiveBaseStore } from "../../service/base-store.test-fixture";
import { adminFixtureIdentity } from "../../store/admin-identity.test-fixture";
import { loadPulseQueriesPageData, loadPulseSettingsPageData, loadPulseWorkspacePageData } from "./page-data";

/**
 * What each page of a base costs on the server: the statements of its one SSR load and the size of what its island
 * receives. The counts are pinned, so a new query per row or a second read of the same thing shows up here.
 */
suiteFor("database", "valkey")("Pulse page loads", () => {
  let memberId: string, baseId: string, accessId: string, deletingId: string;
  const base = newShortId();
  const server = newShortId();
  const shop = newShortId();
  beforeAll(async () => {
    const [person] = await sql<{ id: string }[]>`
      INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`page-member-${crypto.randomUUID()}`}, 'local', 'user', 'Page member') RETURNING id`;
    memberId = person!.id;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO pulse.bases(short_id, name, timezone) VALUES (${base}, 'Werkstatt', 'Europe/Berlin') RETURNING id`;
    baseId = row!.id;
    const [grant] = await sql<{ id: string }[]>`
      INSERT INTO auth.access(user_id, permission) VALUES (${memberId}::uuid, 'admin') RETURNING id`;
    accessId = grant!.id;
    await sql`INSERT INTO pulse.base_access(base_id, access_id) VALUES (${baseId}::uuid, ${accessId}::uuid)`;
    // a base of the member's in deletion: the sidebar names it in the same one statement
    const [gone] = await sql<{ id: string }[]>`
      INSERT INTO pulse.bases(short_id, name, timezone, deletion_started_at)
      VALUES (${newShortId()}, 'Altes Lager', 'Europe/Berlin', now()) RETURNING id`;
    deletingId = gone!.id;
    await sql`INSERT INTO pulse.base_access(base_id, access_id) VALUES (${deletingId}::uuid, ${accessId}::uuid)`;
    await seedActiveBaseStore(baseId);
    const sources = await sql<{ id: string }[]>`
      INSERT INTO pulse.sources(short_id, base_id, kind, name, endpoint_url)
      VALUES (${server}, ${baseId}::uuid, 'metrics', 'Server', 'http://10.0.0.12:9100/metrics'),
             (${shop}, ${baseId}::uuid, 'http_ingest', 'Shop', NULL),
             (${newShortId()}, ${baseId}::uuid, 'metrics', 'Switch', 'http://10.0.0.13:9100/metrics')
      RETURNING id`;
    for (const [index, at] of ["2026-11-25T09:41:00Z", "2026-11-25T09:40:00Z", "2026-11-25T09:39:00Z"].entries())
      await sql`INSERT INTO pulse.source_scrapes(base_id, source_id, started_at, finished_at, duration_ms, success, metrics_count)
        VALUES (${baseId}::uuid, ${sources[0]!.id}::uuid, ${at}::timestamptz, ${at}::timestamptz + interval '1 second', 600,
          ${index > 0}, 86)`;
    await sql`INSERT INTO pulse.base_activity(base_id, kind, actor, data)
      VALUES (${baseId}::uuid, 'source.created', ${JSON.stringify({ kind: "user", id: memberId, name: "Page member" })}::jsonb,
        ${JSON.stringify({ sourceId: server, name: "Server" })}::jsonb)`;
  });
  afterAll(async () => {
    if (baseId) await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
    if (deletingId) await sql`DELETE FROM pulse.bases WHERE id=${deletingId}::uuid`;
    if (accessId) await sql`DELETE FROM auth.access WHERE id=${accessId}::uuid`;
    if (memberId) await sql`DELETE FROM auth.users WHERE id=${memberId}::uuid`;
  });

  /**
   * Runs one loader inside a request for `path` as the member, counting its statements and its island's bytes. The
   * first request fills the caches a running Cloud keeps warm (settings, the day's fetches); the second is measured,
   * as an ordinary page load costs.
   */
  const measure = async (pattern: string, path: string, loader: (c: Context<AuthContext>) => Promise<unknown>) => {
    const identity = adminFixtureIdentity(memberId, false);
    let result: unknown;
    const load = () =>
      new Hono<AuthContext>()
        .use("*", async (c, next) => {
          c.set("actor", identity.actor);
          c.set("accessSubject", identity.accessSubject);
          await next();
        })
        .get(pattern, async (c) => {
          result = await loader(c);
          return c.text("ok");
        })
        .request(`https://cloud.example.test${path}`);
    await load();
    const meter = await meterSql();
    try {
      const statements = await meter.during(async () => load());
      return { statements, bytes: JSON.stringify(result).length, result };
    } finally {
      await meter.close();
    }
  };

  test("each page of a base reads its first view in one load with a pinned number of statements", async () => {
    const pages = {
      sources: await measure("/app/pulse/:baseId", `/app/pulse/${base}`, loadPulseWorkspacePageData),
      open: await measure("/app/pulse/:baseId/sources/:sourceId", `/app/pulse/${base}/sources/${server}`, loadPulseWorkspacePageData),
      push: await measure("/app/pulse/:baseId/sources/:sourceId", `/app/pulse/${base}/sources/${shop}`, loadPulseWorkspacePageData),
      sql: await measure("/app/pulse/:baseId/sql", `/app/pulse/${base}/sql`, loadPulseWorkspacePageData),
      queries: await measure("/app/pulse/:baseId/queries", `/app/pulse/${base}/queries`, (c) => loadPulseQueriesPageData(c, 50)),
      settings: await measure("/app/pulse/:baseId/settings", `/app/pulse/${base}/settings`, (c) => loadPulseSettingsPageData(c, "general")),
    };
    // the statements of one load with warm caches (27.11.2026); a new read per row or a repeated read shows up here
    const pinned: Record<keyof typeof pages, number> = { sources: 23, open: 31, push: 32, sql: 11, queries: 12, settings: 10 };
    for (const [name, page] of Object.entries(pages)) {
      expect({ name, kind: (page.result as { kind?: string } | undefined)?.kind ?? "ok" }).toEqual({ name, kind: "ok" });
      if (page.statements.length !== pinned[name as keyof typeof pages])
        console.info(`pulse page ${name}:\n${page.statements.map((text, index) => `  ${index + 1}. ${text}`).join("\n")}`);
      // what the island receives stays small: the first view, never whole lists
      expect(page.bytes).toBeLessThan(16_000);
      // every service checks access, the page load reads the grant on its base once (the admin faces read their own)
      expect({ name, grantReads: page.statements.filter((text) => text.startsWith("SELECT MAX(a.permission)")).length }).toEqual({
        name,
        grantReads: 1,
      });
    }
    expect(Object.fromEntries(Object.entries(pages).map(([name, page]) => [name, page.statements.length]))).toEqual(pinned);
    // the sidebar names the member's base in deletion beside the open one
    const sidebar = (pages.sources.result as { workspaceProps: { initialNav: { deleting: { name: string }[] } } }).workspaceProps
      .initialNav;
    expect(sidebar.deleting.map((entry) => entry.name)).toEqual(["Altes Lager"]);
  }, 60_000);

  test("the sources page costs the same statements with ten sources as with three", async () => {
    const three = await measure("/app/pulse/:baseId", `/app/pulse/${base}`, loadPulseWorkspacePageData);
    // seven more metrics sources, each with a fetch, so ticks, counts and figures have more to read
    for (let index = 0; index < 7; index++) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO pulse.sources(short_id, base_id, kind, name, endpoint_url)
        VALUES (${newShortId()}, ${baseId}::uuid, 'metrics', ${`More ${index}`}, ${`http://10.0.1.${index}:9100/metrics`}) RETURNING id`;
      await sql`INSERT INTO pulse.source_scrapes(base_id, source_id, started_at, finished_at, duration_ms, success, metrics_count)
        VALUES (${baseId}::uuid, ${row!.id}::uuid, now() - interval '1 minute', now(), 500, true, 12)`;
    }
    const ten = await measure("/app/pulse/:baseId", `/app/pulse/${base}`, loadPulseWorkspacePageData);
    expect((ten.result as { workspaceProps: { initialSources: unknown[] } }).workspaceProps.initialSources).toHaveLength(10);
    expect(ten.statements.length).toBe(three.statements.length);
  }, 60_000);
});
