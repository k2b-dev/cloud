import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { Hono } from "hono";
import * as catalog from "../catalog";

const root = mkdtempSync(join(tmpdir(), "capabilities-page-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./workspace.page");
const appSummary = { id: "mail", name: "Mail", icon: "ti ti-mail", description: "Mail capabilities" };
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const request = (path: string) => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/capabilities/:appId", ...handler);
  app.get("/app/capabilities/:appId/:kind/:capabilityId", ...handler);
  return app.request(`https://cloud.example.test${path}`);
};

test("catalog outage keeps the workspace shell and returns503 for app and operation URLs", async () => {
  spies.push(spyOn(services, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(
    spyOn(catalog, "loadCapabilityWorkspace").mockResolvedValue({
      apps: [appSummary],
      selected: { kind: "unavailable", app: appSummary },
    }),
  );
  for (const path of ["/app/capabilities/mail", "/app/capabilities/mail/query/inbox"]) {
    const response = await request(path);
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toContain("Mail");
    expect(html).toContain("Capability manifest unavailable");
  }
  expect((await request("/app/capabilities/mail/invalid/inbox")).status).toBe(404);
});

test("an absent operation in a ready manifest still returns HTML404", async () => {
  spies.push(
    spyOn(catalog, "loadCapabilityWorkspace").mockResolvedValue({
      apps: [appSummary],
      selected: {
        kind: "ready",
        app: appSummary,
        manifest: { protocolVersion: 1, appId: "mail", manifestHash: "a".repeat(64), types: [], queries: [], actions: [] },
      },
    }),
  );
  const response = await request("/app/capabilities/mail/query/absent");
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("location")).toBeNull();
});
