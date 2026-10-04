import { describe, expect, spyOn, test } from "bun:test";
import * as services from "@k2b/cloud/services";
import { createProxyStats, proxyRequest, redactSensitivePath } from "./proxy";
import { buildRouteTable } from "./trie";

describe("gateway path redaction", () => {
  test("redacts public Mail attachment tokens without changing unrelated paths", () => {
    expect(redactSensitivePath("/share/mail/attachments/secret-token")).toBe("/share/mail/attachments/[REDACTED]");
    expect(redactSensitivePath("/api/mail/public-attachments/secret-token/download")).toBe(
      "/api/mail/public-attachments/[REDACTED]/download",
    );
    expect(redactSensitivePath("/app/mail/a/secret-token")).toBe("/app/mail/a/[REDACTED]");
    expect(redactSensitivePath("/app/mail/inbox")).toBe("/app/mail/inbox");
  });
});

describe("service worker scope", () => {
  test("only Core may widen a worker's scope with Service-Worker-Allowed", async () => {
    const telemetry = spyOn(services, "publishRequestTelemetry").mockImplementation(() => {});
    const upstream = Bun.serve({
      port: 0,
      fetch: () => new Response("self.addEventListener('fetch', () => {});", { headers: { "Service-Worker-Allowed": "/" } }),
    });
    try {
      const baseUrl = `http://127.0.0.1:${upstream.port}`;
      const table = buildRouteTable([
        { prefix: "/", appId: "core", baseUrl },
        { prefix: "/pwa/spaces", appId: "spaces", baseUrl },
      ]);
      const proxy = (path: string) => proxyRequest(new Request(`http://cloud.example${path}`), table, createProxyStats(), () => {});
      expect((await proxy("/service-worker.js")).headers.get("Service-Worker-Allowed")).toBe("/");
      const part = await proxy("/pwa/spaces/sw.js");
      expect(part.headers.get("X-Gateway-App")).toBe("spaces");
      expect(part.headers.has("Service-Worker-Allowed")).toBe(false);
    } finally {
      await upstream.stop(true);
      telemetry.mockRestore();
    }
  });

  test("only the mobile app serves a service worker script below /pwa", async () => {
    const telemetry = spyOn(services, "publishRequestTelemetry").mockImplementation(() => {});
    const hits: string[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch: (req) => {
        hits.push(new URL(req.url).pathname);
        return new Response("self.addEventListener('fetch', () => {});", { headers: { "Content-Type": "text/javascript" } });
      },
    });
    try {
      const baseUrl = `http://127.0.0.1:${upstream.port}`;
      const table = buildRouteTable([
        { prefix: "/", appId: "core", baseUrl },
        { prefix: "/pwa", appId: "pwa", baseUrl },
        { prefix: "/pwa/_auth", appId: "core", baseUrl },
        { prefix: "/pwa/inventory", appId: "inventory", baseUrl },
      ]);
      const proxy = (path: string, worker = true) =>
        proxyRequest(
          new Request(`http://cloud.example${path}`, { headers: worker ? { "Service-Worker": "script" } : {} }),
          table,
          createProxyStats(),
          () => {},
        );
      expect((await proxy("/pwa/sw.js")).status).toBe(200);
      expect((await proxy("/service-worker.js")).status).toBe(200);
      // A script at the bare part root could claim the scope /pwa/.
      for (const path of ["/pwa/inventory", "/pwa/inventory?v=1", "/pwa/inventory/sw.js", "//pwa/inventory", "/pwa/_auth/sw.js"]) {
        expect((await proxy(path)).status).toBe(403);
      }
      expect((await proxy("/pwa/inventory", false)).status).toBe(200);
      expect(hits).toEqual(["/pwa/sw.js", "/service-worker.js", "/pwa/inventory"]);
    } finally {
      await upstream.stop(true);
      telemetry.mockRestore();
    }
  });
});
