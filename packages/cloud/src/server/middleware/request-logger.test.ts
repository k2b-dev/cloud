import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { AuthContext } from "./auth";
import { requestLogger } from "./request-logger";

const entries: unknown[][] = [];
const consoleSpies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  entries.length = 0;
  for (const method of ["log", "warn", "error"] as const) {
    consoleSpies.push(
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        if (args[0] === "[http]") entries.push(args);
      }),
    );
  }
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
  consoleSpies.length = 0;
});

test.each([401, 403, 429, 500, 503] as const)("redacts share tokens from HTTP %s messages and metadata", async (status) => {
  const token = "abcdefghijklmnopqrstuvwxyzABCDEF";
  const app = new Hono<AuthContext>().use("*", requestLogger).get("/share/demo/:token", (c) => c.text("failed", status));
  const response = await app.request(`/share/demo/${token}?password=query-secret`);
  expect(response.status).toBe(status);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.[2]).toMatchObject({ path: "/share/demo/:token", status, method: "GET" });
  expect(entries[0]?.[1]).toContain("/share/demo/:token");
  expect(JSON.stringify(entries)).not.toContain(token);
  expect(JSON.stringify(entries)).not.toContain("query-secret");
});

test("keeps normal paths and skips successful responses and static assets", async () => {
  const app = new Hono<AuthContext>()
    .use("*", requestLogger)
    .get("/api/demo", (c) => c.text("failed", 500))
    .get("/share/demo/:token", (c) => c.text("ok"))
    .get("/public/demo.js", (c) => c.text("failed", 500));
  await app.request("/api/demo?secret=hidden");
  await app.request("/share/demo/secret-token");
  await app.request("/public/demo.js");
  expect(entries).toHaveLength(1);
  expect(entries[0]?.[2]).toMatchObject({ path: "/api/demo" });
});

test("logs the matched calendar handler template in messages and metadata", async () => {
  const token = "0123456789abcdef".repeat(3);
  const app = new Hono<AuthContext>().use("*", requestLogger).get("/api/demo/calendar/:token", (c) => c.text("failed", 500));
  expect((await app.request(`/api/demo/calendar/${token}.ics?secret=query-secret`)).status).toBe(500);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.[1]).toContain("/api/demo/calendar/:token");
  expect(entries[0]?.[2]).toMatchObject({ path: "/api/demo/calendar/:token", status: 500 });
  expect(JSON.stringify(entries)).not.toContain(token);
  expect(JSON.stringify(entries)).not.toContain("query-secret");
});

test("logs the sub-router middleware pattern when it answers early", async () => {
  const api = new Hono<AuthContext>().use("*", async (c) => c.text("rate limited", 429)).get("/calendar/:token", (c) => c.text("ok"));
  const app = new Hono<AuthContext>().use("*", requestLogger).route("/api/demo", api);
  expect((await app.request(`/api/demo/calendar/${"0123456789abcdef".repeat(3)}.ics`)).status).toBe(429);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.[1]).toContain("/api/demo/*");
  expect(entries[0]?.[2]).toMatchObject({ path: "/api/demo/*", status: 429 });
});

test("redacts the fallback when root middleware answers without a route template", async () => {
  const token = "AbCdEfGhIjKlMnOpQrStUv";
  const app = new Hono<AuthContext>()
    .use("*", requestLogger)
    .use("*", async (c) => c.text("unauthorized", 401))
    .get("/api/demo/forms/public/:token", (c) => c.text("ok"));
  expect((await app.request(`/api/demo/forms/public/${token}?secret=query-secret`)).status).toBe(401);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.[1]).toContain("/api/demo/forms/public/:token");
  expect(entries[0]?.[2]).toMatchObject({ path: "/api/demo/forms/public/:token", status: 401 });
  expect(JSON.stringify(entries)).not.toContain(token);
  expect(JSON.stringify(entries)).not.toContain("query-secret");
});

test("logs the matched template after a handler throws", async () => {
  const app = new Hono<AuthContext>()
    .use("*", requestLogger)
    .get("/api/demo/items/:itemId", () => {
      throw new Error("failed");
    })
    .onError((_, c) => c.text("failed", 500));
  expect((await app.request("/api/demo/items/4711")).status).toBe(500);
  expect(entries[0]?.[2]).toMatchObject({ path: "/api/demo/items/:itemId", status: 500 });
});
