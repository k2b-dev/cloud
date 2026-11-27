import { afterAll, beforeAll, describe, expect } from "bun:test";
import { sql } from "@k2b/cloud";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { grantAccess } from "../service/access";
import "./_components/ssr-test-plugin";
import { loadBaseChoices } from "./base-choices";

const { default: gridsPage } = await import("./page");

// Grids has no overview page: /app/grids opens the base someone worked in last while they may still open it, else
// the newest they can open; `?new=` opens the dialog on that base's home; before the first base it shows four ways.
const fixture = {
  reader: testUuid(),
  newcomer: testUuid(),
  older: { id: testUuid(), shortId: testShortId() },
  newer: { id: testUuid(), shortId: testShortId() },
  closed: { id: testUuid(), shortId: testShortId() },
  access: [] as string[],
};

const app = (userId: string) =>
  new Hono<AuthContext>()
    .use("*", async (c, next) => {
      const set = c.set as unknown as (key: string, value: unknown) => void;
      set("runtime", { apps: [] });
      set("actor", { kind: "user", user: { id: userId, memberofGroupIds: [], displayName: "Mira Solberg" } });
      await next();
    })
    .get("/app/grids", ...gridsPage);

const cookieOf = (settings: Record<string, unknown>) => `settings-app-grids=${encodeURIComponent(JSON.stringify(settings))}`;
const open = (userId: string, path: string, lastPath?: string) =>
  app(userId).request(path, { headers: { "accept-language": "de", ...(lastPath ? { cookie: cookieOf({ lastPath }) } : {}) } });

/** The statements a step sends, and what it returned. */
const metered = async <T,>(step: () => T | Promise<T>): Promise<{ statements: number; result: T }> => {
  const meter = await meterSql();
  try {
    const results: T[] = [];
    const statements = await meter.during(async () => {
      results.push(await step());
    });
    const [result] = results;
    if (results.length !== 1 || result === undefined) throw new Error("the step ran no result");
    return { statements: statements.length, result };
  } finally {
    await meter.close();
  }
};

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  for (const [id, name] of [
    [fixture.reader, "Mira Solberg"],
    [fixture.newcomer, "Jonas Kern"],
  ] as const)
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
      VALUES (${id}::uuid, ${`grids-start-${id}`}, 'local', 'user', ${name}, ${name.split(" ")[0]!}, ${name.split(" ")[1]!})`;
  await sql`INSERT INTO grids.bases (id, short_id, name, created_at) VALUES
    (${fixture.older.id}::uuid, ${fixture.older.shortId}, 'Werkstatt', '2026-01-01T00:00:00Z'),
    (${fixture.newer.id}::uuid, ${fixture.newer.shortId}, 'Lager', '2026-02-01T00:00:00Z'),
    (${fixture.closed.id}::uuid, ${fixture.closed.shortId}, 'Gehälter', '2026-03-01T00:00:00Z')`;
  for (const base of [fixture.older, fixture.newer]) {
    const grant = await grantAccess({
      resourceType: "base",
      resourceId: base.id,
      permission: "read",
      principal: { type: "user", userId: fixture.reader },
    });
    if (!grant.ok) throw new Error(grant.error.message);
    fixture.access.push(grant.data.accessId);
  }
});

afterAll(async () => {
  if (!testInfra.database) return;
  for (const id of fixture.access) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
  await sql`DELETE FROM grids.bases WHERE id IN (${fixture.older.id}::uuid, ${fixture.newer.id}::uuid, ${fixture.closed.id}::uuid)`;
  await sql`DELETE FROM auth.users WHERE id IN (${fixture.reader}::uuid, ${fixture.newcomer}::uuid)`;
});

describe("Grids' start", () => {
  postgresTest("opens the page of the base worked in last, with its table and record, in 2 statements", async () => {
    const last = `/app/grids/${fixture.older.shortId}/table/TABLE1?record=REC001`;
    // the last base by its id, and its grants: whether the person may still open it
    const { statements, result: response } = await metered(() => open(fixture.reader, "/app/grids", last));
    expect(statements).toBe(2);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(last);
  });

  postgresTest("opens the newest base the person may open without a last base, or when that base is closed to them", async () => {
    // without a last base the newest the person may open (1); a closed last base costs its id and grants first (3)
    for (const [last, expected] of [
      [undefined, 1],
      [`/app/grids/${fixture.closed.shortId}`, 3],
    ] as const) {
      const { statements, result: response } = await metered(() => open(fixture.reader, "/app/grids", last));
      expect(statements).toBe(expected);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/app/grids/${fixture.newer.shortId}`);
    }
  });

  postgresTest("an old link to the overview lands there too; `new` opens the dialog on that base's home", async () => {
    const old = await open(fixture.reader, "/app/grids?q=lager&page=2&apps=1");
    expect(old.headers.get("location")).toBe(`/app/grids/${fixture.newer.shortId}`);
    const create = await open(fixture.reader, "/app/grids?new=finance", `/app/grids/${fixture.older.shortId}/table/TABLE1`);
    expect(create.headers.get("location")).toBe(`/app/grids/${fixture.older.shortId}?new=finance`);
  });

  postgresTest("before the first base: no sidebar, the line and four ways, the dialog from the address, in 1 statement", async () => {
    // the newest base the person may open (none): the four ways come from the templates in the code
    const { statements, result: response } = await metered(() => open(fixture.newcomer, "/app/grids?new=inventory"));
    expect(statements).toBe(1);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Leg deine erste Base an");
    for (const way of ["Leere Base", "Private Finanzen", "Inventar", "Rechnungswesen"]) expect(html).toContain(way);
    // how many tables each template makes, from the templates themselves
    expect(html).toContain("5 Tabellen");
    expect(html).toContain("Noch ohne Tabellen");
    expect(html).not.toContain('data-k2-part="Nav"');
    expect(html).toContain('href="/app/grids?new=finance"');
  });

  postgresTest("the switcher's bases: the ones opened last first, the rest by name, the closed one nowhere, in 1 statement", async () => {
    const cookie = cookieOf({ recentBases: [fixture.older.shortId, fixture.closed.shortId] });
    const { statements, result } = await metered(() => loadBaseChoices({ userId: fixture.reader, userGroups: [] }, cookie, "de"));
    expect(statements).toBe(1);
    expect(result).toEqual({
      recent: [{ id: fixture.older.shortId, name: "Werkstatt" }],
      others: [{ id: fixture.newer.shortId, name: "Lager" }],
    });
  });
});
