import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { createDisposableDatabase, databaseSuite } from "../../../scripts/fixtures/test-infra";
import { createNotesApp } from "./app";
import { databaseReady, migrate } from "./database";
import { startupCode } from "./start";

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

test("privacy headers cover raw responses and unexpected failures", async () => {
  const app = createNotesApp(async () => true);
  app.get("/raw", () => new Response("ok"));
  app.get("/failure", () => {
    throw new Error("private details");
  });
  const original = console.error;
  const logs: string[] = [];
  console.error = (value: string) => {
    logs.push(value);
  };
  try {
    for (const path of ["/raw", "/failure"]) {
      const response = await app.request(path);
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
      expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
      if (path === "/failure") {
        expect(response.status).toBe(500);
        expect(await response.text()).toContain("internal_error");
      }
    }
    expect(logs).toEqual(["[notes] request_failed"]);
  } finally {
    console.error = original;
  }
});

test("startup diagnostics expose only stable codes", () => {
  expect(startupCode(new Error("notes_schema_newer_than_server"))).toBe("notes_schema_newer_than_server");
  expect(startupCode(new Error("secret connection URL"))).toBe("startup_failed");
  expect(startupCode({ code: "28P01", message: "private details" })).toBe("database_28P01");
  expect(startupCode({ code: "sensitive url value" })).toBe("startup_failed");
});
