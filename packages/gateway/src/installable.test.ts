import { describe, expect, spyOn, test } from "bun:test";
import type { AppInstallable, AppRegistryEntry } from "@k2b/cloud/contracts";
import * as cloudServices from "@k2b/cloud/services";
import { createProxyStats, proxyRequest } from "./proxy";
import { buildAppRoutesDetailed } from "./routes";
import { buildRouteTable, matchRoute } from "./trie";

const surface = (id: string): AppInstallable => ({
  path: `/app/${id}/counter/`,
  name: `${id} counter`,
  shortName: id,
  icon: "ti ti-pencil",
  themeColor: { light: "#fafafa", dark: "#090d12" },
  display: "standalone",
});
const app = (id: string, routes: string[], installable?: AppInstallable): AppRegistryEntry => ({
  id,
  name: id,
  icon: "ti ti-pencil",
  description: id,
  baseUrl: `http://${id}.invalid`,
  routes,
  installable,
});

describe("App-PWA ownership", () => {
  test("two installations coexist; old foreign records cannot take over ancestors, descendants or generated assets", () => {
    const { routes, warnings } = buildAppRoutesDetailed([
      app("core", ["/"]),
      app("inventory", ["/app/inventory"], surface("inventory")),
      app("orders", ["/app/orders"], surface("orders")),
      app("a-legacy", [
        "/app",
        "/app/inventory",
        "/app/inventory/counter",
        "/app/inventory/counter/documents",
        "/app/inventory/counter/sw.js",
        "//app//orders//counter/manifest.webmanifest",
      ]),
    ]);
    expect(warnings).toHaveLength(6);
    const table = buildRouteTable(routes);
    expect(table.installables).toHaveLength(2);
    for (const id of ["inventory", "orders"]) {
      for (const suffix of ["", "/", "/documents/123", "/sw.js", "/manifest.webmanifest"]) {
        expect(matchRoute(table, `/app/${id}/counter${suffix}`)?.appId).toBe(id);
      }
    }
    expect(matchRoute(table, "/auth/login")?.appId).toBe("core");
  });

  test("malformed declarations close all routes and cannot fall back to Core or a foreign old app", () => {
    const { routes, warnings } = buildAppRoutesDetailed([
      app("core", ["/", "/app/inventory/counter"]),
      app("inventory", ["/app/inventory"], { ...surface("inventory"), path: "/app/orders/counter/" }),
      app("old", ["/app/inventory/counter/documents"]),
    ]);
    expect(warnings).toHaveLength(3);
    expect(matchRoute(buildRouteTable(routes), "/app/inventory/counter/sw.js")).toBeNull();
    // Same result when the registry reader has already rejected the malformed record entirely.
    const absent = buildRouteTable(buildAppRoutesDetailed([app("core", ["/"]), app("old", ["/app/inventory/counter"])]).routes);
    expect(matchRoute(absent, "/app/inventory/counter/")).toBeNull();
  });

  test("rejects encoded, backslash and dot route aliases instead of granting ownership after normalization", () => {
    const { routes, warnings } = buildAppRoutesDetailed([
      app("old", [
        "/app/%69nventory/counter",
        "/app\\inventory\\counter",
        "/app/old/../inventory/counter",
        "/app/inventory/counter?x",
        "/app/inventory/counter#x",
      ]),
    ]);
    expect(routes).toEqual([]);
    expect(warnings.every((warning) => warning.reason === "invalid_prefix")).toBe(true);
  });

  test("only exact generated workers may load, including for a Core-owned installation; only the root push worker may widen scope", async () => {
    const telemetry = spyOn(cloudServices, "publishRequestTelemetry").mockImplementation(() => {});
    const hits: string[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        hits.push(new URL(req.url).pathname);
        return new Response("worker", { headers: { "Content-Type": "text/javascript", "Service-Worker-Allowed": "/" } });
      },
    });
    try {
      const apps = [
        app("core", ["/", "/app/core"], surface("core")),
        app("inventory", ["/app/inventory"], surface("inventory")),
        app("orders", ["/app/orders"], surface("orders")),
        app("pwa", ["/pwa"]),
      ];
      const table = buildRouteTable(buildAppRoutesDetailed(apps.map((entry) => ({ ...entry, baseUrl: upstream.url.origin }))).routes);
      const proxy = (path: string, worker = true) =>
        proxyRequest(
          new Request(`http://cloud.test${path}`, { headers: worker ? { "Service-Worker": "script" } : {} }),
          table,
          createProxyStats(),
          () => {},
          null,
          () => {},
        );
      for (const id of ["inventory", "orders", "core"]) {
        expect((await proxy(`/app/${id}/counter/sw.js`)).status).toBe(200);
        expect((await proxy(`/app/${id}/counter/sw.js`, false)).headers.has("Service-Worker-Allowed")).toBe(false);
        for (const suffix of ["", "/", "/other.js", "/sw.js?version=1", "/nested/sw.js", "//sw.js"]) {
          expect((await proxy(`/app/${id}/counter${suffix}`)).status).toBe(403);
        }
        expect((await proxy(`/app/${id}/worker.js`)).status).toBe(403);
      }
      for (const path of ["/root.js", "/app", "/app/worker.js", "/public/inventory/sw.js", "/pwa", "/pwa/sw.js?scope=/"]) {
        expect([403, 502]).toContain((await proxy(path)).status);
      }
      expect((await proxy("/service-worker.js")).headers.get("Service-Worker-Allowed")).toBe("/");
      expect((await proxy("/pwa/sw.js")).status).toBe(200);
      expect(hits).toHaveLength(8);
    } finally {
      await upstream.stop(true);
      telemetry.mockRestore();
    }
  });
});

test("a confirmed all-invalid registry snapshot removes the previous App-PWA routes", async () => {
  const cloud = JSON.stringify(Bun.resolveSync("@k2b/cloud", import.meta.dir));
  const runtime = JSON.stringify(new URL("./runtime.ts", import.meta.url).pathname);
  const stats = JSON.stringify(new URL("./stats.ts", import.meta.url).pathname);
  const script = `
    import { mock } from "bun:test";
    import { strict as assert } from "node:assert";
    let table = { routeCount: 0, installables: [] };
    mock.module(${stats}, () => ({ stats: {}, getRouteTable: () => table, setRouteTable: (value) => { table = value; } }));
    mock.module(${JSON.stringify(new URL("./config.ts", import.meta.url).pathname)}, () => ({ gatewayRouter: { id: "gateway-test", baseUrl: "http://gateway.test" } }));
    let rejected = false;
    mock.module(${cloud}, () => ({ buildRuntimeFromRegistry: () => ({}), startProcessSync: async () => ({}), watchAppRegistry: async () => {}, readAppRegistrySnapshot: async () => ({
      apps: rejected ? [] : [{ id: "inventory", name: "Inventory", icon: "ti ti-box", description: "", baseUrl: "http://inventory.invalid", routes: ["/app/inventory"], installable: ${JSON.stringify(surface("inventory"))} }],
      issues: rejected ? [{ key: "apps/inventory", reason: "invalid installable", version: "2" }] : []
    }) }));
    mock.module("@k2b/cloud/services", () => ({ logger: () => ({ info() {}, warn() {}, error(error) { throw new Error(String(error)); } }), buildGatewayRouteSnapshot: () => ({}), publishGatewayRouteSnapshot: async () => {}, removeGatewayRouteSnapshot: async () => {}, superviseRuntimeTask: async () => {} }));
    const { refreshRoutes } = await import(${runtime});
    const { getRouteTable } = await import(${stats});
    await refreshRoutes();
    assert.equal(getRouteTable().routeCount, 1);
    assert.equal(getRouteTable().installables.length, 1);
    rejected = true;
    await refreshRoutes();
    assert.equal(getRouteTable().routeCount, 0);
    assert.equal(getRouteTable().installables.length, 0);
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: new URL("../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" });
  } finally {
    child.kill();
    await child.exited;
  }
});
