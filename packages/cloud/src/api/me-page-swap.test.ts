import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { PageSwapFallbackReport } from "../contracts/page-swap-fallback";
import { createMePageSwapRoutes } from "./me-page-swap";

test("page swap fallback reports require a user and accept only the app, the reason and a status", async () => {
  const recorded: PageSwapFallbackReport[] = [];
  const routes = createMePageSwapRoutes((value) => recorded.push(value));
  const app = new Hono<{ Variables: { user: { id: string } } }>()
    .use("*", async (c, next) => {
      c.set("user", { id: "authenticated-fixture" });
      await next();
    })
    .route("/", routes);
  const post = (body: unknown) =>
    app.request("/page-swap-fallbacks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((await post({ appId: "faq", reason: "timeout" })).status).toBe(204);
  expect((await post({ appId: "faq", reason: "status", status: 503 })).status).toBe(204);
  expect(recorded).toEqual([
    { appId: "faq", reason: "timeout" },
    { appId: "faq", reason: "status", status: 503 },
  ]);
  const anonymous = await routes.request("/page-swap-fallbacks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: "faq", reason: "timeout" }),
  });
  expect(anonymous.status).toBe(401);
  for (const invalid of [
    { appId: "faq", reason: "unknown" },
    { appId: "faq", reason: "status", status: 42 },
    { appId: "FAQ", reason: "timeout" },
    { appId: "faq", reason: "timeout", url: "/app/faq/private" },
    { appId: "faq", reason: "timeout", userId: "other" },
  ])
    expect((await post(invalid)).status).toBe(400);
  expect((await post({ appId: "faq", reason: "timeout", padding: "x".repeat(512) })).status).toBe(413);
  expect(recorded).toHaveLength(2);
});
