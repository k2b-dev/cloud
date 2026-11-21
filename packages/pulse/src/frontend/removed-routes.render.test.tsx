import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineApp } from "@k2b/cloud";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { requireAppAccess } from "@k2b/cloud/server/middleware/app-access";
import { Hono } from "hono";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import * as config from "../config";
import * as store from "../store/service";
import * as gate from "./not-set-up";

const root = mkdtempSync(join(tmpdir(), "pulse-removed-routes-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const render = defineApp({
  id: "pulse",
  name: "Pulse",
  icon: "ti ti-activity-heartbeat",
  description: "Removed routes render fixture",
  baseUrl: "http://pulse.fixture",
  routes: ["/app/pulse"],
  appRoot: root,
});
const renderer = spyOn(config, "ssr").mockImplementation(render.ssr);
// The spy replaces the function, so it also needs the fixture's explicit error response.
Object.assign(renderer, { error: render.ssr.error });
let gated = 0;
const block = spyOn(gate, "pulseNotSetUpGate").mockImplementation(() => async (c) => {
  gated += 1;
  return c.text("private gate", 503);
});
// An unconfigured store must not turn the removed link into a 503.
const configured = spyOn(store, "pulseStoreConfigured").mockResolvedValue(false);
const { default: routes, redirectRemovedView } = await import("./index");
const { default: api } = await import("../api");
const pages = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
  .use(
    "*",
    requireAppAccess(config.app.meta, async () => new Response("Pulse denied", { status: 403 })),
  )
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .route("/app/pulse", routes)
  .route("/api/pulse", api);
afterAll(() => {
  renderer.mockRestore();
  block.mockRestore();
  configured.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

test("a shared dashboard link answers 410 with a minimal page that names no dashboard", async () => {
  for (const [language, title, detail] of [
    ["de", "Dieser Link gilt nicht mehr", "Geteilte Pulse-Dashboards wurden entfernt."],
    ["en", "This link is no longer valid", "Shared Pulse dashboards were removed"],
  ]) {
    const response = await pages.request("/app/pulse/public/fictional-token?range=7d", { headers: { "Accept-Language": language! } });
    expect(response.status).toBe(410);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    const html = await response.text();
    expect(html).toContain(`<title>${title}`);
    expect(html).toContain(detail!);
    expect(html).not.toContain("fictional-token");
    expect(html).not.toContain("private gate");
  }
  expect(gated).toBe(0);
});

test("the public dashboard API answers 410 before the store gate", async () => {
  for (const path of ["/api/pulse/public/fictional-token", "/api/pulse/public/fictional-token/panels/visits"]) {
    const response = await pages.request(path);
    expect(response.status).toBe(410);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ code: "GONE" });
  }
  // Paths outside the declared public routes stay behind sign-in.
  for (const path of ["/api/pulse/public/fictional-token/private", "/app/pulse/public/fictional-token/private"])
    expect((await pages.request(path)).status).toBe(401);
});

test("old dashboard and overview paths open the base", async () => {
  const app = new Hono<AuthContext>()
    .get("/app/pulse/:baseId/dashboards/:dashboardId", redirectRemovedView("dashboards-removed"))
    .get("/app/pulse/:baseId/overview", redirectRemovedView());
  const dashboard = await app.request("/app/pulse/Base01/dashboards/Dash01?range=7d");
  expect(dashboard.status).toBe(302);
  expect(dashboard.headers.get("location")).toBe("/app/pulse/Base01?notice=dashboards-removed");
  const overview = await app.request("/app/pulse/Base01/overview");
  expect(overview.status).toBe(302);
  expect(overview.headers.get("location")).toBe("/app/pulse/Base01");
});

test("only current workspace routes render pages", () => {
  const paths = routes.routes.filter((route) => route.method === "GET").map((route) => route.path);
  expect(paths).toContain("/:baseId/sql");
  expect(paths).toContain("/:baseId/sources/:sourceId");
  expect(paths).toContain("/:baseId/dashboards/:dashboardId");
  for (const path of paths) {
    expect(path).not.toMatch(/\/(explorer|signals|resources|events|metrics|states|query-reference)(?:\/|$)/);
    expect(path).not.toContain("/edit");
    expect(path).not.toContain("*");
  }
});
