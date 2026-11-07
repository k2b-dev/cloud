import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { connect } from "node:net";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { redis } from "../runtime/clients";

import * as store from "../services/settings/store";
import { servePublicStorage } from "./public-storage";

useUnitClients();

let calls: { method: string; path: string }[];
let type: string;
let size: number;
let server: ReturnType<typeof Bun.serve>;
let restore: () => void;
beforeEach(() => {
  calls = [];
  type = "image/png";
  size = 5;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      calls.push({ method: request.method, path: new URL(request.url).pathname });
      if (new URL(request.url).pathname.endsWith("/missing")) return new Response(null, { status: 404 });
      return new Response(request.method === "HEAD" ? null : "image", {
        headers: {
          "Content-Length": String(size),
          "Content-Type": type,
          ETag: '"test-etag"',
          "Last-Modified": "Wed, 28 Oct 2026 12:00:00 GMT",
        },
      });
    },
  });
  const config: Record<string, unknown> = {
    "storage.endpoint": server.url.origin,
    "storage.region": "garage",
    "storage.bucket": "cloud-test",
    "storage.access_key_id": "test-access",
    "storage.secret_access_key": "test-secret",
    "storage.max_object_bytes": 32,
  };
  const read = spyOn(store, "readStates").mockImplementation(
    async (keys) => new Map(keys.map((key) => [key, { stored: "readable" as const, value: config[key] }])),
  );
  const readKey = spyOn(store, "readKey").mockResolvedValue(60);
  const counter = spyOn(redis, "send").mockResolvedValue([1, 0, "1"]);
  restore = () => {
    counter.mockRestore();
    readKey.mockRestore();
    read.mockRestore();
  };
});
afterEach(async () => {
  restore();
  await server.stop(true);
});
const request = (key = "photo.png", init?: RequestInit) => new Request(`https://cloud.example.test/public/storage/inventory/${key}`, init);

test.each([
  "",
  "/a",
  "x//a",
  "x/",
  "../secret",
  "x/../secret",
  "x/./secret",
  "%2e%2e/secret",
  "x%2f..%2fsecret",
  "%5csecret",
  "%252e%252e/secret",
  "100%25.pdf",
  "%00secret",
  "%0asecret",
  "cafe%CC%81.png",
  "%ED%A0%80",
  "x\\secret",
  "a".repeat(1024),
])("invalid public path %j is a 404 before contacting S3", async (key) => {
  // Preserve transport spelling: Request's WHATWG constructor would already
  // remove literal/encoded dot segments before the handler can inspect them.
  const raw = request();
  Object.defineProperty(raw, "url", { value: `https://cloud.example.test/public/storage/inventory/${key}` });
  expect((await servePublicStorage(raw)).status).toBe(404);
  expect(calls).toEqual([]);
  expect(redis.send).not.toHaveBeenCalled();
  expect(store.readKey).not.toHaveBeenCalled();
  expect(store.readStates).not.toHaveBeenCalled();
});

test("anonymous GET and HEAD force the public area and preserve metadata without listing", async () => {
  const response = await servePublicStorage(request("caf%C3%A9/a%3Fb%23c.png"));
  expect(response.status).toBe(200);
  expect(response.headers.get("etag")).toBe('"test-etag"');
  expect(response.headers.get("last-modified")).toBe("Wed, 28 Oct 2026 12:00:00 GMT");
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.text()).toBe("image");
  expect(calls.map((call) => call.method)).toEqual(["HEAD", "GET"]);
  expect(calls.every((call) => call.path.startsWith("/cloud-test/public/inventory/"))).toBe(true);
  calls = [];
  const head = await servePublicStorage(request("photo.png", { method: "HEAD" }));
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect(calls.map((call) => call.method)).toEqual(["HEAD"]);
  for (const method of ["PUT", "POST", "DELETE"]) expect((await servePublicStorage(request("photo.png", { method }))).status).toBe(404);
  expect((await servePublicStorage(new Request("https://cloud.example.test/public/storage/inventory/"))).status).toBe(404);
});
test.each([
  "text/html",
  "image/svg+xml",
  "application/xhtml+xml",
  "text/html; charset=utf-8",
  "text/html ;charset=utf-8",
  "text/xml",
  "application/rss+xml",
  "application/pdf",
])("active content %s is sandboxed and downloaded", async (contentType) => {
  type = contentType;
  const response = await servePublicStorage(request("active"));
  expect(response.headers.get("content-disposition")).toBe("attachment");
  expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
  await response.body?.cancel();
});
test("conditional GET uses HEAD alone and missing/oversized objects are not served", async () => {
  const cached = await servePublicStorage(request("photo.png", { headers: { "If-None-Match": '"test-etag"' } }));
  expect(cached.status).toBe(304);
  expect(calls.map((call) => call.method)).toEqual(["HEAD"]);
  expect((await servePublicStorage(request("missing"))).status).toBe(404);
  size = 33;
  expect((await servePublicStorage(request())).status).toBe(404);
});

test("Bun HTTP normalizes dot segments but delivery remains confined to public objects", async () => {
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => servePublicStorage(request) });
  try {
    for (const [key, status] of [
      ["x/../photo.png", 200],
      ["x/%2e%2e/photo.png", 200],
      ["../other/photo.png", 200],
      ["x%2f..%2fphoto.png", 404],
      ["%252e%252e/photo.png", 404],
      ["../../private/inventory/photo.png", 404],
    ] as const) {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(gateway.port), "127.0.0.1", () =>
          socket.write(`GET /public/storage/inventory/${key} HTTP/1.1\r\nHost: cloud.example.test\r\nConnection: close\r\n\r\n`),
        );
        let data = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          data += chunk;
        });
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });
      expect(response).toStartWith(`HTTP/1.1 ${status}`);
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.path.startsWith("/cloud-test/public/"))).toBe(true);
  } finally {
    await gateway.stop(true);
  }
});

test("anonymous rate limits are shared, fail closed and run before storage settings or S3", async () => {
  const counter = spyOn(redis, "send").mockResolvedValue([61, 0, "61"]);
  const response = await servePublicStorage(request(), "203.0.113.2");
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBeTruthy();
  expect(calls).toEqual([]);
  expect(counter.mock.calls[0]?.[1]).toContainEqual(expect.stringContaining("ip:203.0.113.2"));
  counter.mockRejectedValue(new Error("Redis unavailable"));
  expect((await servePublicStorage(request(), "203.0.113.2")).status).toBe(503);
  expect(calls).toEqual([]);
});
