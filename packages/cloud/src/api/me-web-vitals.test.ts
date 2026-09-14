import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { WebVitalsReport } from "../contracts/web-vitals";
import { createMeWebVitalsRoutes } from "./me-web-vitals";

const report: WebVitalsReport = {
  appId: "notebooks",
  routeTemplate: "/app/notebooks/:id",
  id: "measurement-1",
  name: "LCP",
  value: 950,
  navigationType: "navigate",
  serverTiming: { auth: 3, settings: 2, ssr_data: 30, ssr_finalize: 4, ssr_render: 5 },
};

test("performance reports require a user and accept only bounded diagnostic fields", async () => {
  const recorded: WebVitalsReport[] = [];
  let enabled = true;
  const routes = createMeWebVitalsRoutes(
    (value) => recorded.push(value),
    async () => enabled,
  );
  const app = new Hono<{ Variables: { user: { id: string } } }>()
    .use("*", async (c, next) => {
      c.set("user", { id: "authenticated-fixture" });
      await next();
    })
    .route("/", routes);
  const post = (body: unknown, target = app) =>
    target.request("/web-vitals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await post(report)).status).toBe(204);
  expect(recorded).toEqual([report]);
  enabled = false;
  expect((await post(report)).status).toBe(204);
  expect(recorded).toHaveLength(1);
  const anonymous = await routes.request("/web-vitals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
  });
  expect(anonymous.status).toBe(401);
  for (const invalid of [
    { ...report, value: -1 },
    { ...report, name: "HTML" },
    { ...report, entries: [{ url: "private" }] },
    { ...report, routeTemplate: "/app/notebooks?query=private" },
    { ...report, userId: "other" },
    { ...report, serverTiming: { secret: 1 } },
  ])
    expect((await post(invalid)).status).toBe(400);
  expect((await post({ ...report, padding: "x".repeat(4096) })).status).toBe(413);
  expect(recorded).toHaveLength(1);
  enabled = true;
  expect((await post(report)).status).toBe(204);
  expect(recorded).toHaveLength(2);
});
