import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cloud from "@k2b/cloud";
import type { AuthContext } from "@k2b/cloud/server";
import { coreSettings, logging, type WebVitalsOverview } from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "browser-vitals-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { browserTelemetryPage } = await import("./page");
const empty: WebVitalsOverview = { summary: [], series: [], routes: [], totalRoutes: 0, page: 1, perPage: 50 };
const app = cloud.defineApp({
  id: "vitals-render",
  name: "Vitals",
  icon: "ti ti-chart",
  description: "Render fixture",
  baseUrl: "http://localhost:3000",
  routes: ["/"],
});
const server = new Hono<AuthContext & { Variables: { runtime: { apps: [] } } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .get("/", ...app.ssr(browserTelemetryPage));
test("Browser SSR distinguishes retained, empty and failed reads and localizes the initial controls", async () => {
  const read = spyOn(logging, "webVitals").mockResolvedValue(empty);
  const settings = spyOn(coreSettings, "get").mockResolvedValue(false);
  const apps = spyOn(cloud, "listAppsDetailed").mockResolvedValue([]);
  try {
    for (const [locale, label] of [
      ["de", "Web-Vitals erfassen"],
      ["en", "Collect Web Vitals"],
    ]) {
      const response = await server.request("/?view=browser", { headers: { "Accept-Language": locale! } });
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain(label!);
      expect(html).not.toContain('role="alert"');
    }
    read.mockRejectedValueOnce(new Error("query unavailable"));
    const failed = await (await server.request("/?view=browser")).text();
    expect(failed).toContain("Could not load browser measurements");
    expect(failed).not.toContain("No measurements in this selection");
    read.mockResolvedValue({
      ...empty,
      summary: [{ name: "CLS", count: 1, p75: 0 }],
      series: [{ name: "CLS", count: 1, p75: 0, bucket: Date.now() - 60 * 60 * 1000 }],
    });
    const retained = await (await server.request("/?view=browser")).text();
    expect(retained).toContain("Previously recorded measurements remain visible");
    expect(retained).toContain("CLS · p75");
    expect(retained).toContain("k2b-chart-explorer");
  } finally {
    read.mockRestore();
    settings.mockRestore();
    apps.mockRestore();
  }
});
