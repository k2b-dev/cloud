import { test, describe, beforeAll, afterAll, expect, mock } from "bun:test";
import { sql } from "bun";
import { testIdentity } from "./identity";
const isolated = /\/cloud_kit_rsql_test(?:\?|$)/.test(process.env.DATABASE_URL ?? "") && Boolean(process.env.RSQL_TEST_URL);
(isolated ? describe : describe.skip)("Kit databases against disposable Postgres and rsql", () => {
  const owner = testIdentity("00000000-0000-4000-8000-000000000011"),
    use = testIdentity("00000000-0000-4000-8000-000000000012"),
    stranger = testIdentity("00000000-0000-4000-8000-000000000013");
  const admin = testIdentity("00000000-0000-4000-8000-000000000014");
  admin.user!.roles = ["admin"];
  let database: typeof import("../src/service/database").database, projects: typeof import("../src/service").projects;
  let id = "",
    second = "";
  const settings: Record<string, unknown> = {
    "kit.rsql_enabled": false,
    "kit.rsql_url": process.env.RSQL_TEST_URL,
    "kit.rsql_api_token": process.env.RSQL_TEST_TOKEN,
  };
  beforeAll(async () => {
    mock.module("../src/config", () => ({
      app: {
        settings: {
          get: async (key: string) => settings[key],
          set: async (key: string, value: unknown) => {
            settings[key] = value;
          },
        },
      },
    }));
    ({ database } = await import("../src/service/database"));
    ({ projects } = await import("../src/service"));
    await sql`CREATE SCHEMA auth`;
    await sql`CREATE TYPE auth.permission_level AS ENUM ('none','read','write','admin')`;
    await sql`CREATE TABLE auth.users(id uuid PRIMARY KEY)`;
    await sql`CREATE TABLE auth.groups(id uuid PRIMARY KEY,name text,provider text)`;
    await sql`CREATE TABLE auth.user_groups_v2(user_id uuid,group_id uuid)`;
    await sql`CREATE TABLE auth.group_groups_v2(parent_group_id uuid,child_group_id uuid)`;
    await sql`CREATE TABLE auth.access(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,group_id uuid,service_account_id uuid,authenticated_only boolean DEFAULT false,permission auth.permission_level)`;
    for (const who of [owner, use, stranger, admin]) await sql`INSERT INTO auth.users VALUES(${who.user!.id}::uuid)`;
    await (await import("../src/migrate")).migrate();
    const { blankStarter } = await import("../src/starter");
    id = (await projects.create(blankStarter, owner)).id;
    second = (await projects.create(blankStarter, owner)).id;
    const [grant] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(user_id,permission) VALUES(${use.user!.id}::uuid,'write') RETURNING id`;
    await sql`INSERT INTO kit.project_access SELECT id,${grant!.id}::uuid FROM kit.projects WHERE short_id=${id}`;
  });
  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS kit CASCADE`;
    await sql`DROP SCHEMA IF EXISTS auth CASCADE`;
    mock.restore();
  });
  test("global off gates activation; global administration is separate from app admin", async () => {
    await expect(database.enable(id, true, owner)).rejects.toMatchObject({ code: "DB_GLOBALLY_DISABLED" });
    await expect(database.settings(owner)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await database.configure({ enabled: true, url: process.env.RSQL_TEST_URL }, admin);
    const redacted = await database.settings(admin);
    expect(JSON.stringify(redacted)).not.toContain(process.env.RSQL_TEST_TOKEN!);
    expect(redacted.tokenSet).toBe(true);
  });
  test("activation, permissions, shared rows and namespace isolation", async () => {
    const state = await database.enable(id, true, owner);
    expect(state.status).toBe("ready");
    await database.enable(second, true, owner);
    await database.call(
      id,
      state.generation,
      {
        operation: "tables.create",
        name: "items",
        columns: [
          { name: "label", type: "text" },
          { name: "amount", type: "integer" },
        ],
      },
      owner,
    );
    await expect(database.call(id, state.generation, { operation: "tables.delete", table: "items" }, use)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    await database.call(
      id,
      state.generation,
      {
        operation: "rows.insert",
        table: "items",
        rows: [
          { label: "one", amount: 100 },
          { label: "two", amount: 200 },
        ],
      },
      use,
    );
    expect(JSON.stringify(await database.call(id, state.generation, { operation: "rows.list", table: "items" }, owner))).toContain("one");
    await expect(database.status(id, stranger)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(await database.call(second, (await database.status(second, owner)).generation, { operation: "tables.list" }, owner)).toEqual([]);
    const diag = await database.status(id, owner, true);
    expect(diag.overview?.schema.tables).toBe(1);
    expect(diag.tables?.[0]?.row_count).toBe(2);
    expect(
      JSON.stringify(await database.call(id, state.generation, { operation: "query", sql: "SELECT SUM(amount) AS total FROM items" }, use)),
    ).toContain("300");
    await expect(database.call(id, state.generation, { operation: "query", sql: "SELECT * FROM _meta" }, use)).rejects.toMatchObject({
      code: "DB_SQL_UNSUPPORTED",
    });
  });
  test("imports use real schema types and do not replay writes", async () => {
    const { importData } = await import("../src/database-import");
    const state = await database.status(second, owner);
    const execute = (request: import("../src/database-contracts").DatabaseRequest) =>
      database.call(second, state.generation, request, owner);
    const rows = [{ label: "001", active: true, details: { x: 1 } }];
    expect((await importData("imports", rows, { createTable: true }, execute)).status).toBe("complete");
    expect((await importData("imports", rows, {}, execute)).status).toBe("complete");
    expect((await database.status(second, owner, true)).tables?.[0]?.row_count).toBe(2);
  });
  test("bulk insert constraint failure does not partially commit", async () => {
    const state = await database.status(second, owner);
    await database.call(
      second,
      state.generation,
      { operation: "tables.create", name: "unique_items", columns: [{ name: "reference", type: "text", unique: true }] },
      owner,
    );
    await expect(
      database.call(
        second,
        state.generation,
        { operation: "rows.insert", table: "unique_items", rows: [{ reference: "same" }, { reference: "same" }] },
        owner,
      ),
    ).rejects.toThrow();
    const diag = await database.status(second, owner, true);
    expect(diag.tables?.find((t) => t.name === "unique_items")?.row_count).toBe(0);
  });
  test("pending provisioning and deletion recover after rsql unavailability", async () => {
    const { blankStarter } = await import("../src/starter");
    const recovery = (await projects.create(blankStarter, owner)).id;
    const original = settings["kit.rsql_url"];
    settings["kit.rsql_url"] = "http://127.0.0.1:1";
    try {
      expect((await database.enable(recovery, true, owner)).status).toBe("provisioning");
    } finally {
      settings["kit.rsql_url"] = original;
    }
    await database.reconcile(recovery);
    expect((await database.status(recovery, owner)).status).toBe("ready");
    await projects.remove(recovery, owner);
    settings["kit.rsql_url"] = "http://127.0.0.1:1";
    try {
      await database.reconcile();
    } finally {
      settings["kit.rsql_url"] = original;
    }
    const [pending] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM kit.database_cleanup`;
    expect(pending!.n).toBeGreaterThan(0);
    await database.reconcile();
  });
  test("disable preserves rows; reset invalidates old generation", async () => {
    const old = await database.status(id, owner);
    await database.enable(id, false, owner);
    await expect(database.call(id, old.generation, { operation: "tables.list" }, owner)).rejects.toMatchObject({ code: "DB_DISABLED" });
    const next = await database.enable(id, true, owner);
    expect(next.generation).toBe(old.generation);
    expect((await database.status(id, owner, true)).tables?.[0]?.row_count).toBe(2);
    const reset = await database.enable(id, false, owner, true);
    expect(reset.generation).toBe(old.generation + 1);
    expect(reset.enabled).toBe(true);
    await expect(database.call(id, old.generation, { operation: "tables.list" }, owner)).rejects.toMatchObject({ code: "DB_STALE" });
    expect(await database.call(id, reset.generation, { operation: "tables.list" }, owner)).toEqual([]);
  });
  test("global off preserves configuration and cleanup still deletes databases", async () => {
    await expect(database.configure({ enabled: true, url: "http://other-server:8080" }, admin)).rejects.toMatchObject({
      code: "DB_SERVER_IN_USE",
    });
    await database.configure({ enabled: false, url: process.env.RSQL_TEST_URL }, admin);
    expect((await database.status(id, owner)).enabled).toBe(true);
    await expect(database.call(id, 2, { operation: "tables.list" }, owner)).rejects.toMatchObject({ code: "DB_GLOBALLY_DISABLED" });
    await projects.remove(id, admin);
    await projects.remove(second, admin);
    const [pending] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM kit.database_cleanup`;
    expect(pending!.n).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) await database.reconcile();
    const [clean] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM kit.database_cleanup`;
    expect(clean!.n).toBe(0);
  });
});
