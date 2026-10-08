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
