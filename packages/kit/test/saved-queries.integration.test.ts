import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../src/migrate";
import { projects } from "../src/service";
import { savedQueries } from "../src/service/saved-queries";
import { blankStarter } from "../src/starter";
import { testIdentity } from "./identity";
const isolated = /\/cloud_kit_queries_test(?:\?|$)/.test(process.env.DATABASE_URL ?? "");
(isolated ? describe : describe.skip)("Saved Kit queries in disposable Postgres", () => {
  const owner = testIdentity("00000000-0000-4000-8000-000000000001"),
    use = testIdentity("00000000-0000-4000-8000-000000000002"),
    stranger = testIdentity("00000000-0000-4000-8000-000000000003");
  let id = "",
    other = "";
  beforeAll(async () => {
    await sql`CREATE SCHEMA auth`;
    await sql`CREATE TYPE auth.permission_level AS ENUM ('none','read','write','admin')`;
    await sql`CREATE TABLE auth.users(id uuid PRIMARY KEY)`;
    await sql`CREATE TABLE auth.groups(id uuid PRIMARY KEY,name text,provider text)`;
    await sql`CREATE TABLE auth.user_groups_v2(user_id uuid,group_id uuid)`;
    await sql`CREATE TABLE auth.group_groups_v2(parent_group_id uuid,child_group_id uuid)`;
    await sql`CREATE TABLE auth.access(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,group_id uuid,service_account_id uuid,authenticated_only boolean DEFAULT false,permission auth.permission_level)`;
    for (const who of [owner, use, stranger]) await sql`INSERT INTO auth.users VALUES(${who.user!.id}::uuid)`;
    await migrate();
    await migrate();
    id = (await projects.create(blankStarter, owner)).id;
    other = (await projects.create(blankStarter, owner)).id;
    const [grant] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(user_id,permission) VALUES(${use.user!.id}::uuid,'write') RETURNING id`;
    await sql`INSERT INTO kit.project_access SELECT id,${grant!.id}::uuid FROM kit.projects WHERE short_id=${id}`;
  });
  afterAll(async () => {
    await sql`DROP SCHEMA kit CASCADE`;
    await sql`DROP SCHEMA auth CASCADE`;
    await sql.close();
  });
  test("Use can read, Admin writes, and project identity scopes every operation", async () => {
    const q = await savedQueries.create(id, { name: "Totals", sql: "SELECT 1;" }, owner);
    expect((await savedQueries.list(id, 1, use)).items[0]!.id).toBe(q.id);
    expect(await savedQueries.get(id, q.id, use)).toEqual(q);
    await expect(savedQueries.list(id, 1, stranger)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(savedQueries.create(id, { name: "No", sql: "SELECT 1" }, use)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(savedQueries.update(id, q.id, { name: "No", sql: "SELECT 2", revision: 1 }, use)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    await expect(savedQueries.delete(id, q.id, { revision: 1 }, use)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(savedQueries.get(other, q.id, owner)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(savedQueries.update(other, q.id, { name: "No", sql: "SELECT 2", revision: 1 }, owner)).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    await expect(savedQueries.delete(other, q.id, { revision: 1 }, owner)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });
  test("concurrent writes and deletes cannot overwrite a newer query", async () => {
    const q = await savedQueries.create(id, { name: "Concurrency", sql: "SELECT 1" }, owner);
    const outcomes = await Promise.allSettled(
      [2, 3].map((n) => savedQueries.update(id, q.id, { name: "Changed", sql: `SELECT ${n}`, revision: 1 }, owner)),
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    const current = await savedQueries.get(id, q.id, owner);
    expect(current.revision).toBe(2);
    await expect(savedQueries.delete(id, q.id, { revision: 1 }, owner)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await savedQueries.delete(id, q.id, { revision: 2 }, owner);
    await expect(savedQueries.get(id, q.id, owner)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  test("names are scoped, filterable and cannot be created concurrently twice", async () => {
    const outcomes = await Promise.allSettled([1, 2].map((n) => savedQueries.create(id, { name: "Unique", sql: `SELECT ${n}` }, owner)));
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const matches = await savedQueries.list(id, 1, use, "Unique");
    expect(matches.items).toHaveLength(1);
    const target = matches.items[0]!;
    await savedQueries.update(id, target.id, { name: "Unique", sql: "SELECT 42", revision: target.revision }, owner);
    expect((await savedQueries.get(id, target.id, owner)).sql).toBe("SELECT 42");
    await expect(savedQueries.update(id, target.id, { name: "Unique", sql: "SELECT 43", revision: target.revision }, owner)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const another = await savedQueries.create(id, { name: "Another", sql: "SELECT 1" }, owner);
    await expect(savedQueries.update(id, another.id, { name: "Unique", sql: "SELECT 1", revision: another.revision }, owner)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });
  test("summaries paginate and omit SQL; database lifecycle preserves queries, app deletion cascades", async () => {
    for (let n = 0; n < 52; n++) await savedQueries.create(other, { name: `Query ${String(n).padStart(2, "0")}`, sql: "SELECT 1" }, owner);
    const first = await savedQueries.list(other, 1, owner),
      second = await savedQueries.list(other, 2, owner);
    expect(first.items).toHaveLength(50);
    expect(first.hasNext).toBe(true);
    expect(second.items).toHaveLength(2);
    expect(second.hasNext).toBe(false);
    expect("sql" in first.items[0]!).toBe(false);
    await sql`INSERT INTO kit.project_databases(project_id,enabled,generation) SELECT id,false,2 FROM kit.projects WHERE short_id=${other}`;
    await sql`UPDATE kit.project_databases SET enabled=false,generation=generation+1 WHERE project_id=(SELECT id FROM kit.projects WHERE short_id=${other})`;
    expect((await savedQueries.list(other, 1, owner)).items).toHaveLength(50);
    await projects.remove(other, owner);
    const remaining = await sql`SELECT id FROM kit.saved_queries WHERE id=${first.items[0]!.id}::uuid`;
    expect(remaining).toHaveLength(0);
  });
});
