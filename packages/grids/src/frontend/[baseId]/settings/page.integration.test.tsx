import { afterAll, beforeAll, describe, expect } from "bun:test";
import { sql } from "@k2b/cloud";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { meterSql } from "../../../../../../scripts/fixtures/sql-meter";
import { testInfra } from "../../../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../../../integration-test-utils";
import { migrate } from "../../../migrate";
import "../../_components/ssr-test-plugin";

const { default: settingsPage } = await import("./page");

// A base's settings as a page of their own: who manages the base opens General and Access with what the open tab
// shows read on the server; a reader is refused. Measured with sql-meter, alone in this file (#4494).
const fixture = { admin: testUuid(), reader: testUuid(), baseId: testUuid(), basePublicId: testShortId(), access: [] as string[] };

const app = (userId: string) =>
  new Hono<AuthContext>()
    .use("*", async (c, next) => {
      const set = c.set as unknown as (key: string, value: unknown) => void;
      set("runtime", { apps: [] });
      set("actor", { kind: "user", user: { id: userId, memberofGroupIds: [], displayName: "Mira Solberg" } });
      await next();
    })
    .get("/app/grids/:baseId/settings", ...settingsPage)
    .get("/app/grids/:baseId/settings/:tab", ...settingsPage);

const open = (userId: string, path: string) => app(userId).request(path, { headers: { "accept-language": "de" } });

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  for (const [id, name] of [
    [fixture.admin, "Mira Solberg"],
    [fixture.reader, "Jonas Kern"],
  ] as const)
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
      VALUES (${id}::uuid, ${`grids-settings-${id}`}, 'local', 'user', ${name}, ${name.split(" ")[0]!}, ${name.split(" ")[1]!})`;
  await sql`INSERT INTO grids.bases (id, short_id, name, description)
    VALUES (${fixture.baseId}::uuid, ${fixture.basePublicId}, 'Werkstatt', 'Aufträge und Ersatzteile')`;
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name, position) VALUES (${testUuid()}::uuid, ${testShortId()}, ${fixture.baseId}::uuid, 'Aufträge', 0)`;
  for (const [userId, permission] of [
    [fixture.admin, "admin"],
    [fixture.reader, "read"],
  ] as const) {
    const [grant] = await sql<{ id: string }[]>`
      INSERT INTO auth.access (user_id, permission) VALUES (${userId}::uuid, ${permission}::auth.permission_level) RETURNING id::text AS id`;
    fixture.access.push(grant!.id);
    await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${fixture.baseId}::uuid, ${grant!.id}::uuid)`;
  }
});

afterAll(async () => {
  if (!testInfra.database) return;
  await sql`DELETE FROM grids.audit_log WHERE base_id = ${fixture.baseId}::uuid`;
  await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
  for (const id of fixture.access) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
  await sql`DELETE FROM auth.users WHERE id IN (${fixture.admin}::uuid, ${fixture.reader}::uuid)`;
});

describe("a base's settings page", () => {
  postgresTest("General and Access for who manages the base, a reader refused, and what each costs", async () => {
    const base = `/app/grids/${fixture.basePublicId}/settings`;
    // the tab in the address: General has the page's own address
    const general = await open(fixture.admin, `${base}/general`);
    expect(general.status).toBe(302);
    expect(general.headers.get("location")).toBe(base);
    expect((await open(fixture.reader, base)).status).toBe(403);
    // warm the process's caches once, then measure each tab
    await open(fixture.admin, base);
    const meter = await meterSql();
    try {
      const pages: Record<string, { status: number; html: string; statements: number }> = {};
      for (const [tab, path] of [
        ["general", base],
        ["access", `${base}/access`],
      ] as const) {
        let response: Response | undefined;
        const statements = await meter.during(async () => {
          response = await open(fixture.admin, path);
        });
        pages[tab] = { status: response?.status ?? 0, html: (await response?.text()) ?? "", statements: statements.length };
      }
      console.info(`grids settings: general ${pages.general?.statements} statements, access ${pages.access?.statements}`);
      expect(pages.general).toMatchObject({ status: 200, statements: GENERAL_STATEMENTS });
      expect(pages.general?.html).toContain("Name und Beschreibung");
      expect(pages.general?.html).toContain("Aufträge und Ersatzteile");
      // the access list only for Access: its grants and the names of who they name, two statements more
      expect(pages.access).toMatchObject({ status: 200, statements: GENERAL_STATEMENTS + 2 });
      expect(pages.access?.html).toContain("Personen und Gruppen");
      expect(pages.access?.html).toContain("Jonas Kern");
    } finally {
      await meter.close();
    }
  });
});

/** The budget of General, measured on 27.11. after the caches of the process were warm. */
const GENERAL_STATEMENTS = 16;
