import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineApp } from "@k2b/cloud";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import { type AuthContext, err, fail, ok } from "@k2b/cloud/server";
import { requireAppAccess } from "@k2b/cloud/server/middleware/app-access";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import * as config from "../config";
import * as panels from "../service/dashboard-panels";
import * as gate from "./not-set-up";
import { dashboardTestDashboard } from "./workspace/dashboard-test-fixtures";

const root = mkdtempSync(join(tmpdir(), "pulse-public-dashboard-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const render = defineApp({
  id: "pulse",
  name: "Pulse",
  icon: "ti ti-activity-heartbeat",
  description: "Public dashboard render fixture",
  baseUrl: "http://pulse.fixture",
  routes: ["/app/pulse"],
  appRoot: root,
});
const renderer = spyOn(config, "ssr").mockImplementation(render.ssr);
let gated = 0;
const block = spyOn(gate, "pulseNotSetUpGate").mockImplementation(() => async (c) => {
  gated += 1;
  return c.text("private gate", 503);
});
const document = {
  id: dashboardTestDashboard.id,
  name: dashboardTestDashboard.name,
  revision: dashboardTestDashboard.revision,
  panels: dashboardTestDashboard.definition.panels.map(({ sql: _sql, params: _params, ...panel }) => panel),
};
const panelRead = spyOn(panels, "readDashboardPanel").mockResolvedValue(fail(err.notFound("Dashboard panel")));
const read = spyOn(panels, "readPublicDashboard").mockResolvedValue(ok(document));
const { default: routes } = await import("./index");
const { publicDashboardRoutes } = await import("../api/routes/dashboards");
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
  .route("/api/pulse", publicDashboardRoutes);
afterAll(() => {
  renderer.mockRestore();
  block.mockRestore();
  read.mockRestore();
  panelRead.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

test("anonymous public SSR is before the private auth/store gate and exposes presentation only with no-store/no-referrer", async () => {
  read.mockClear();
  for (let index = 0; index < 2; index++) {
    const response = await pages.request("/app/pulse/public/fictional-token?range=7d", { headers: { "Accept-Language": "de" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    const html = await response.text();
    expect(html).toMatch(/<title>[^<]*Server &amp; Traefik[^<]*<\/title>/);
    expect(html).toContain("minimal-layout-footer");
    expect(html).toContain("Server &amp; Traefik");
    expect(html).toContain("ti ti-router");
    expect(html).toContain("ti ti-server-2");
    expect(html).toContain("Quelle Traefik · Raster 5 Min.");
    expect(html).toContain("2 Quellen · Raster 5 Min.");
    expect(html).toContain("Lädt");
    expect(html).not.toContain("fictional-private-host");
    expect(html).not.toContain("SELECT time");
    expect(html).not.toContain("pulse-panel-sql");
    expect(html).not.toContain("Mit KI fragen");
    expect(html).not.toContain("private gate");
  }
  expect(gated).toBe(0);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith("fictional-token");
});

test("revoked public link renders an actionable minimal error without redirecting to sign-in", async () => {
  read.mockResolvedValueOnce(fail(err.notFound("Dashboard publication")));
  const response = await pages.request("/app/pulse/public/revoked-token", { headers: { "Accept-Language": "de" } });
  expect(response.status).toBe(404);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  const html = await response.text();
  expect(html).toMatch(/<title>[^<]*Dashboard nicht verfügbar[^<]*<\/title>/);
  expect(html).toContain("Dashboard nicht verfügbar");
  expect(html).toContain("Erneut versuchen");
  expect(html).not.toContain("SELECT time");
});

test("an initial metadata outage keeps a minimal retry page and never exposes the thrown error", async () => {
  read.mockRejectedValueOnce(new Error("fictional-sensitive-database-detail"));
  const response = await pages.request("/app/pulse/public/fictional-token", { headers: { "Accept-Language": "de" } });
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  const html = await response.text();
  expect(html).toContain("minimal-layout-footer");
  expect(html).toMatch(/<title>[^<]*Die Pulse-Daten konnten nicht aktualisiert werden[^<]*<\/title>/);
  expect(html).toContain("Dashboard konnte nicht geladen werden");
  expect(html).toContain("Erneut versuchen");
  expect(html).not.toContain("fictional-sensitive-database-detail");
});

test("only current workspace routes are mounted", () => {
  const paths = routes.routes.filter((route) => route.method === "GET").map((route) => route.path);
  expect(paths).toContain("/:baseId/sql");
  expect(paths).toContain("/:baseId/dashboards/:dashboardId");
  expect(paths).toContain("/:baseId/sources/:sourceId");
  for (const path of paths) {
    expect(path).not.toMatch(/\/(explorer|signals|resources|events|metrics|states|query-reference)(?:\/|$)/);
    expect(path).not.toContain("/edit");
    expect(path).not.toContain("*");
  }
});

test("anonymous public API reaches publication checks while private neighbors stay gated", async () => {
  const response = await pages.request("/api/pulse/public/fictional-token");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(document);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  const panel = await pages.request("/api/pulse/public/fictional-token/panels/visits");
  expect(panel.status).toBe(404);
  expect(panelRead).toHaveBeenCalledWith(expect.objectContaining({ token: "fictional-token", panelId: "visits" }));
  read.mockResolvedValueOnce(fail(err.notFound("Dashboard publication")));
  const revoked = await pages.request("/api/pulse/public/revoked-token");
  expect(revoked.status).toBe(404);
  for (const path of [
    "/api/pulse/bases",
    "/api/pulse/public/fictional-token/private",
    "/app/pulse/public/fictional-token/private",
    "/admin/pulse",
  ]) {
    expect((await pages.request(path)).status).toBe(401);
  }
});
