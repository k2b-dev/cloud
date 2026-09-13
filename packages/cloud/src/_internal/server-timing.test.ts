import { expect, test } from "bun:test";
import { Hono } from "hono";
import { measureServerPhase } from "./server-timing";

test("concurrent requests keep timing headers separate and preserve failures", async () => {
  const app = new Hono()
    .get("/settings", async (c) => {
      await measureServerPhase(c, "settings", () => Promise.resolve());
      return c.text("ok");
    })
    .get("/auth", async (c) => {
      try {
        await measureServerPhase(c, "auth", () => {
          throw new Error("Denied");
        });
      } catch {
        return c.text("Denied", 403);
      }
      return c.text("Unexpected");
    });
  const [settings, auth] = await Promise.all([app.request("/settings"), app.request("/auth")]);
  expect(settings.headers.get("Server-Timing")).toMatch(/^settings;dur=\d+\.\d+$/);
  expect(auth.headers.get("Server-Timing")).toMatch(/^auth;dur=\d+\.\d+$/);
  expect(auth.status).toBe(403);
});
