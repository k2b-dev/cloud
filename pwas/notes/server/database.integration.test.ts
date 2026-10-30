import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { createDisposableDatabase, databaseSuite } from "../../../scripts/fixtures/test-infra";
import { createNotesApp } from "./app";
import { databaseReady, migrate } from "./database";

databaseSuite()("Notes standalone database", () => {
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let db: SQL;
  beforeAll(async () => {
    database = await createDisposableDatabase("notes_schema");
    db = new SQL(database.url);
    await Promise.all([migrate(db), migrate(db)]);
  });
  afterAll(async () => {
    await db?.close();
    await database?.drop();
  });
  test("first boot is concurrency-safe and repeatable", async () => {
    await migrate(db);
    expect(await databaseReady(db)).toBe(true);
    const tables = await db<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`;
    expect(tables.map((t) => t.table_name)).toContain("pad_updates");
    expect(tables.map((t) => t.table_name)).not.toContain("users");
  });
  test("health separates process liveness from schema readiness", async () => {
    const app = createNotesApp(() => databaseReady(db));
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);
    await db`INSERT INTO notes_schema_migrations(version) VALUES(999)`;
    expect((await app.request("/readyz")).status).toBe(503);
    expect((await app.request("/healthz")).status).toBe(200);
    await db`DELETE FROM notes_schema_migrations WHERE version=999`;
  });
});

test("readiness failure returns a stable code without exception details", async () => {
  const app = createNotesApp(async () => {
    throw new Error("private database details");
  });
  const response = await app.request("/readyz");
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private database");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
});
