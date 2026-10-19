import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { logging, trace } from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import * as health from "../health";
import * as telemetry from "./telemetry/service";

const root = mkdtempSync(join(tmpdir(), "observability-range-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "admin",
  roles: ["user", "admin"],
  provider: "local",
  profile: "user",
  givenname: "Ada",
  sn: "Admin",
  displayName: "Ada Admin",
  mail: "admin@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

const server = () => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/admin/observability", ...handler);
  return app;
};

test("overview range navigation preserves the default and explicit range URLs when sources are unavailable", async () => {
  const unavailable = new Error("Fixture source unavailable");
  const spies = [
    stubRailSnapshot(),
    spyOn(health, "buildGatewayHealth").mockRejectedValue(unavailable),
    spyOn(telemetry, "getTelemetryOverview").mockRejectedValue(unavailable),
    spyOn(telemetry, "getTelemetryTimeseries").mockResolvedValue([]),
    spyOn(telemetry, "listTelemetryRoutes").mockResolvedValue([]),
    spyOn(logging, "summary").mockRejectedValue(unavailable),
    spyOn(logging, "timeseries").mockResolvedValue([]),
    spyOn(trace, "stats").mockRejectedValue(unavailable),
  ];
  try {
    const app = server();
    for (const [query, current] of [
      ["", "24h"],
      ["?range=7d", "7d"],
    ]) {
      const response = await app.request(`/admin/observability${query}`, { headers: { "Accept-Language": "en" } });
      const html = await response.text();
      expect(response.status, html).toBe(200);
      const nav = html.match(/<nav[^>]*class="k2b-view-tabs[^>]*>[\s\S]*?<\/nav>/)?.[0];
      expect(nav).toBeDefined();
      const links = [...nav!.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
      expect(links).toHaveLength(5);
      for (const [index, range] of ["1h", "6h", "24h", "7d", "30d"].entries()) {
        const attrs = links[index]![1]!;
        expect(attrs).toContain(`href="/admin/observability${range === "24h" ? "" : `?range=${range}`}"`);
        expect(attrs.includes('aria-current="page"')).toBe(range === current);
      }
      expect(nav).not.toContain('data-variant="primary"');
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
