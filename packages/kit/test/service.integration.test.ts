import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../src/migrate";
import { projects } from "../src/service";
import { blankStarter } from "../src/starter";
import { testIdentity } from "./identity";
const isolated = /\/cloud_kit_authoring_test(?:\?|$)/.test(process.env.DATABASE_URL ?? "");
const owner = testIdentity("00000000-0000-4000-8000-000000000001");
const reader = testIdentity("00000000-0000-4000-8000-000000000002");
const use = testIdentity("00000000-0000-4000-8000-000000000003");
const stranger = testIdentity("00000000-0000-4000-8000-000000000004");
let id = "";
const source = "// 😀\n" + "// source\n".repeat(5000);
(isolated ? describe : describe.skip)("Kit source service in disposable Postgres", () => {
  beforeAll(async () => {
    await sql`CREATE SCHEMA auth`;
    await sql`CREATE TYPE auth.permission_level AS ENUM ('none','read','write','admin')`;
    await sql`CREATE TABLE auth.users (id uuid PRIMARY KEY)`;
    await sql`CREATE TABLE auth.groups (id uuid PRIMARY KEY, name text, provider text)`;
    await sql`CREATE TABLE auth.user_groups_v2 (user_id uuid, group_id uuid)`;
    await sql`CREATE TABLE auth.group_groups_v2 (parent_group_id uuid, child_group_id uuid)`;
    await sql`CREATE TABLE auth.access (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, group_id uuid, service_account_id uuid, authenticated_only boolean DEFAULT false, permission auth.permission_level)`;
    for (const identity of [owner, reader, use, stranger]) await sql`INSERT INTO auth.users VALUES (${identity.user!.id}::uuid)`;
    await migrate();
    const project = await projects.create(
      { ...blankStarter, files: [...blankStarter.files, { path: "helper.js", content: source }] },
      owner,
    );
    id = project.id;
    for (const [identity, level] of [
      [reader, "read"],
      [use, "write"],
    ] as const) {
      const [grant] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access(user_id, permission) VALUES (${identity.user!.id}::uuid, ${level}::auth.permission_level) RETURNING id`;
      await sql`INSERT INTO kit.project_access SELECT id, ${grant!.id}::uuid FROM kit.projects WHERE short_id=${id}`;
    }
  });
  afterAll(async () => {
    await sql`DROP SCHEMA kit CASCADE`;
    await sql`DROP SCHEMA auth CASCADE`;
    await sql.close();
  });
  test("metadata, source and writes obey separate access levels", async () => {
    expect((await projects.manifest(id, reader)).permission).toBe("read");
    await expect(projects.readSource({ id, path: "helper.js", expectedRevision: 1 }, reader)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    expect((await projects.readSource({ id, path: "helper.js", expectedRevision: 1 }, use)).offset).toBe(0);
    await expect(projects.manifest(id, stranger)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    const changes = { expectedRevision: 1, upsert: [{ path: "new.js", content: "" }] };
    await expect(projects.changeSource(id, changes, use, true)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(projects.changeSource(id, changes, use)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  test("source windows reconstruct one revision without losing Unicode or advancing on failure", async () => {
    let reconstructed = "",
      offset = 0;
    while (true) {
      const window = await projects.readSource({ id, path: "helper.js", expectedRevision: 1, offset }, use);
      expect(new TextEncoder().encode(JSON.stringify({ data: window })).byteLength).toBeLessThan(256 * 1024);
      reconstructed += window.content;
      if (window.complete) break;
      expect(window.nextOffset).toBeGreaterThan(offset);
      offset = window.nextOffset!;
    }
    expect(reconstructed).toBe(source);
    await expect(projects.readSource({ id, path: "helper.js", expectedRevision: 2 }, use)).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
  });
  test("validation is read-only, invalid changes roll back, and concurrent saves cannot overwrite", async () => {
    const changes = {
      expectedRevision: 1,
      upsert: [{ path: "extra.script.js", content: 'export default kit.script({ name: "Extra", run() {} });' }],
    };
    expect(await projects.changeSource(id, changes, owner)).toMatchObject({ revision: 1, valid: true });
    expect((await projects.get(id, owner)).files).toHaveLength(2);
    await expect(projects.changeSource(id, { expectedRevision: 1, delete: ["main.script.js"] }, owner, true)).rejects.toThrow();
    expect((await projects.get(id, owner)).revision).toBe(1);
    const attempts = await Promise.allSettled([
      projects.changeSource(id, changes, owner, true),
      projects.changeSource(id, changes, owner, true),
    ]);
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "REVISION_CONFLICT" } });
    const after = await projects.get(id, owner);
    expect(after.files.find((f) => f.path === "helper.js")?.content).toBe(source);
    expect(after.revision).toBe(2);
    expect(after.entries).toHaveLength(2);
  });
  test("metadata update preserves source and range edit preserves other files", async () => {
    await projects.metadata(id, { expectedRevision: 2, name: "Renamed" }, owner);
    await projects.changeSource(
      id,
      { expectedRevision: 3, edits: [{ path: "helper.js", offset: 0, deleteCount: 6, content: "// replaced\n" }] },
      owner,
      true,
    );
    const after = await projects.get(id, owner);
    expect(after.name).toBe("Renamed");
    expect(after.revision).toBe(4);
    expect(after.files).toHaveLength(3);
    expect(after.files.find((f) => f.path === "helper.js")?.content).toBe("// replaced\n" + source.slice(6));
  });
});
