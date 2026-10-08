import { describe, expect, spyOn, test } from "bun:test";
import * as services from "@k2b/cloud/services";
import { createProxyStats, proxyRequest } from "./proxy";
import { buildRouteTable } from "./trie";

describe("public share telemetry", () => {
  const token = "abcdefghijklmnopqrstuvwxyzABCDEF";

  test("redacts unmatched share requests", async () => {
    const telemetry = spyOn(services, "publishRequestTelemetry").mockImplementation(() => {});
    try {
      const response = await proxyRequest(
        new Request(`http://cloud.test//share/demo/${token}/?secret=query-secret`),
        buildRouteTable([]),
        createProxyStats(),
        () => {},
      );
      expect(response.status).toBe(502);
      expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ pathTemplate: "/share/demo/:token", errorKind: "unmatched_route" }));
      expect(JSON.stringify(telemetry.mock.calls)).not.toContain(token);
      expect(JSON.stringify(telemetry.mock.calls)).not.toContain("query-secret");
    } finally {
      telemetry.mockRestore();
    }
  });

  test("uses the same redacted template in upstream failure logs and telemetry", async () => {
    const telemetry = spyOn(services, "publishRequestTelemetry").mockImplementation(() => {});
    const upstream = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error(`Cannot connect to http://upstream/share/demo/${token}?secret=query-secret`),
    );
    const entries: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
    try {
      const response = await proxyRequest(
        new Request(`http://cloud.test/share/demo/${token}`),
        buildRouteTable([{ prefix: "/share/demo", appId: "share-failure", baseUrl: "http://upstream" }]),
        createProxyStats(),
        (message, metadata) => entries.push({ message, metadata }),
      );
      expect(response.status).toBe(502);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.metadata?.path).toBe("/share/demo/:token");
      expect(telemetry).toHaveBeenCalledWith(
        expect.objectContaining({ pathTemplate: entries[0]?.metadata?.path, errorKind: "upstream_unavailable" }),
      );
      expect(JSON.stringify(entries)).not.toContain(token);
      expect(JSON.stringify(entries)).not.toContain("query-secret");
      expect(await response.text()).not.toContain(token);
    } finally {
      upstream.mockRestore();
      telemetry.mockRestore();
    }
  });

  test("redacts an answered request without a route-template header", async () => {
    const telemetry = spyOn(services, "publishRequestTelemetry").mockImplementation(() => {});
    const upstream = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    try {
      const response = await proxyRequest(
        new Request(`http://cloud.test/share/demo/${token}`),
        buildRouteTable([{ prefix: "/share/demo", appId: "demo", baseUrl: "http://upstream" }]),
        createProxyStats(),
        () => {},
      );
      expect(response.status).toBe(200);
      expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ pathTemplate: "/share/demo/:token", errorKind: null }));
      expect(JSON.stringify(telemetry.mock.calls)).not.toContain(token);
    } finally {
      upstream.mockRestore();
      telemetry.mockRestore();
    }
  });
});

describe("client address headers", () => {
  test("replace the client's forwarding headers with the resolved address", async () => {
    const telemetry = spyOn(services, "publishRequestTelemetry").mockImplementation(() => {});
    const seen: Record<string, string | null>[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch: (req) => {
        seen.push(
          Object.fromEntries(
            ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "forwarded"].map((name) => [name, req.headers.get(name)]),
          ),
        );
        return new Response("ok");
      },
    });
    try {
      const table = buildRouteTable([{ prefix: "/", appId: "core", baseUrl: `http://127.0.0.1:${upstream.port}` }]);
      const spoofed = {
        "X-Forwarded-For": "198.51.100.7",
        "X-Real-IP": "198.51.100.7",
        "CF-Connecting-IP": "198.51.100.7",
        Forwarded: "for=198.51.100.7",
      };
      const proxy = (client: Parameters<typeof proxyRequest>[4]) =>
        proxyRequest(new Request("http://cloud.example/", { headers: spoofed }), table, createProxyStats(), () => {}, client);
      await proxy({ address: "203.0.113.10", forwardedFor: "203.0.113.10, 172.18.0.2" });
      await proxy(null);
      expect(seen).toEqual([
        { "x-forwarded-for": "203.0.113.10, 172.18.0.2", "x-real-ip": "203.0.113.10", "cf-connecting-ip": null, forwarded: null },
        { "x-forwarded-for": null, "x-real-ip": null, "cf-connecting-ip": null, forwarded: null },
      ]);
    } finally {
      await upstream.stop(true);
      telemetry.mockRestore();
    }
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

describe("byte ranges", () => {
  test("a range request reaches the app and its 206 answer reaches the browser unchanged", async () => {
    const telemetry = spyOn(services, "publishRequestTelemetry").mockImplementation(() => {});
    const video = new Uint8Array(4096).map((_, index) => index % 251);
    const ranges: (string | null)[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch: (req) => {
        const range = req.headers.get("range");
        ranges.push(range);
        const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
        if (!match) return new Response(video, { headers: { "Content-Type": "video/webm", "Accept-Ranges": "bytes" } });
        const [start, end] = [Number(match[1]), Number(match[2])];
        return new Response(video.slice(start, end + 1), {
          status: 206,
          headers: {
            "Content-Type": "video/webm",
            "Accept-Ranges": "bytes",
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${video.length}`,
          },
        });
      },
    });
    const table = buildRouteTable([{ prefix: "/", appId: "spaces", baseUrl: `http://127.0.0.1:${upstream.port}` }]);
    // The gateway answers on the wire as in production, so the browser sees what Bun.serve sends.
    const gateway = Bun.serve({ port: 0, fetch: (req) => proxyRequest(req, table, createProxyStats(), () => {}, null) });
    try {
      const response = await fetch(`http://127.0.0.1:${gateway.port}/api/spaces/S/items/I/attachments/A/content`, {
        headers: { Range: "bytes=1000-1999" },
      });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes 1000-1999/${video.length}`);
      expect(response.headers.get("content-length")).toBe("1000");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(video.subarray(1000, 2000));
      expect(ranges).toEqual(["bytes=1000-1999"]);
    } finally {
      await gateway.stop(true);
      await upstream.stop(true);
      telemetry.mockRestore();
    }
  });
});
