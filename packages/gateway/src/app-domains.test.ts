import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from "node:zlib";
import type { AppRegistryEntry } from "@k2b/cloud/contracts";
import { domainCheckKey } from "@k2b/cloud/contracts/app-domains";
import { type AuthContext, clientIp, rateLimit } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { redis } from "bun";
import { Hono } from "hono";
import { cloudHostSet, type DomainSnapshot } from "./app-domains";
import { createGatewayHandler } from "./handler";
import { createProxyStats } from "./proxy";
import { buildRouteTable } from "./trie";

const app = (baseUrl: string) => ({
  id: "site",
  name: "Site",
  icon: "globe",
  description: "",
  baseUrl,
  routes: ["/app/site"],
  public: true,
});
const client = { address: "203.0.113.7", forwardedFor: "203.0.113.7" };
const servers: Array<{ stop: (closeActiveConnections?: boolean) => unknown }> = [];
let telemetry: ReturnType<typeof spyOn>;
beforeEach(() => {
  telemetry = spyOn(services, "publishRequestTelemetry").mockImplementation(() => {});
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  telemetry.mockRestore();
});

const fixture = (
  respond: (req: Request) => Response | Promise<Response> = (req) =>
    Response.json({
      path: new URL(req.url).pathname + new URL(req.url).search,
      headers: Object.fromEntries(req.headers),
    }),
) => {
  const requests: Request[] = [];
  const upstream = Bun.serve({
    port: 0,
    fetch: (req) => {
      requests.push(req);
      return respond(req);
    },
  });
  servers.push(upstream);
  const snapshot: DomainSnapshot = {
    cloudHosts: cloudHostSet("https://cloud.test", ["http://gateway:3000"], false),
    domainsReady: true,
    domains: new Map([
      ["site.test", { host: "site.test", appId: "site", redirectTo: null, createdAt: "2026-10-30T00:00:00Z" }],
      ["alias.test", { host: "alias.test", appId: "site", redirectTo: "site.test", createdAt: "2026-10-30T00:00:00Z" }],
    ]),
    apps: new Map<string, AppRegistryEntry>([["site", app(upstream.url.href)]]),
    development: false,
  };
  const table = buildRouteTable([
    { prefix: "/", appId: "core", baseUrl: upstream.url.href },
    { prefix: "/app/site", appId: "site", baseUrl: upstream.url.href },
  ]);
  let storageCalls = 0;
  let active = snapshot;
  const answers = new Map<string, string>();
  const rates: Array<[string, string]> = [];
  let rateResponse: Response | null = null;
  const handle = createGatewayHandler({
    snapshot: () => active,
    table: () => table,
    stats: createProxyStats(),
    log: () => {},
    health: () => Response.json({ instanceId: "gateway-health" }),
    storage: async () => {
      storageCalls++;
      return new Response("cloud storage");
    },
    rate: async (host, address) => {
      rates.push([host, address]);
      return rateResponse;
    },
    readDomainCheckAnswer: async (key) => answers.get(key) ?? null,
  });
  return {
    requests,
    snapshot,
    answers,
    rates,
    storageCalls: () => storageCalls,
    setSnapshot: (next: DomainSnapshot) => {
      active = next;
    },
    setRateResponse: (response: Response) => {
      rateResponse = response;
    },
    request: async (path = "/", options: RequestInit = {}, host = "site.test") => {
      const headers = new Headers(options.headers);
      headers.set("Host", host);
      const response = await handle(
        new Request(`http://transport.test${path}`, { ...options, headers }),
        { timeout: () => {}, upgrade: () => false },
        client,
      );
      if (!response) throw new Error("Unexpected upgrade");
      return response;
    },
    handle,
  };
};

test.each([
  ["/api/core?x=1", "core"],
  ["/_cloud/app-access", "core"],
  ["/app/site/_cloud/access/site", "site"],
])("Cloud host keeps path routing and gateway headers for %s", async (path, appId) => {
  const f = fixture();
  const response = await f.request(path, {}, "cloud.test");
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Gateway-App")).toBe(appId);
  expect((await response.json()).path).toBe(path);
  expect(f.rates).toEqual([]);
});

test.each(["/", "/api/anything", "/public/storage/files/a", "/health"])("app host owns %s", async (path) => {
  const f = fixture();
  const response = await f.request(`${path}?q=a%2Fb&x=+&x=%20`);
  const body = await response.json();
  expect(body.path).toBe(`/_cloud/public${path}?q=a%2Fb&x=+&x=%20`);
  expect(body.headers["x-cloud-public-host"]).toBe("site.test");
  expect(body.headers["x-forwarded-proto"]).toBe("https");
  expect(f.storageCalls()).toBe(0);
  expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ appId: "site", routePrefix: "/" }));
});

test.each(["GET", "HEAD", "POST"])("alias %s keeps escaped path and query", async (method) => {
  const f = fixture();
  const response = await f.request("/a%2fb//c?x=+&x=%20&empty=", { method }, "alias.test");
  expect(response.status).toBe(method === "POST" ? 308 : 301);
  expect(response.headers.get("Location")).toBe("https://site.test/a%2fb//c?x=+&x=%20&empty=");
  expect(f.requests).toHaveLength(0);
});

test("only Host selects the domain and normalizes case, trailing dot and port", async () => {
  const f = fixture();
  expect((await f.request("/", { headers: { "X-Forwarded-Host": "site.test" } }, "unknown.test")).status).toBe(421);
  expect((await f.request("/", {}, "SITE.TEST.:443")).status).toBe(200);
  expect((await f.request("/", {}, "gateway:3000")).headers.get("X-Gateway-App")).toBe("core");
});

test.each(["/health", "/_cloud/ready"])("unknown hosts retain container probe %s", async (path) => {
  const f = fixture();
  expect((await f.request(path, {}, "unknown.test")).status).toBe(200);
  expect(f.requests).toHaveLength(0);
});

test("unknown hosts reject normal routes and storage", async () => {
  const f = fixture();
  for (const path of ["/", "/api/core", "/public/storage/a"]) expect((await f.request(path, {}, "unknown.test")).status).toBe(421);
  expect(f.storageCalls()).toBe(0);
});

test("an assigned app without a public declaration is rejected", async () => {
  const f = fixture();
  f.setSnapshot({ ...f.snapshot, apps: new Map([["site", { ...app("http://absent"), public: false }]]) });
  expect((await f.request()).status).toBe(421);
});

test("an assigned app missing from the ready registry is retryable", async () => {
  const f = fixture();
  f.setSnapshot({ ...f.snapshot, apps: new Map() });
  const response = await f.request();
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("5");
});

test("a registered app with a failed transport is retryable", async () => {
  const f = fixture();
  const closed = Bun.serve({ port: 0, fetch: () => new Response("unused") });
  const baseUrl = closed.url.href;
  await closed.stop(true);
  f.setSnapshot({ ...f.snapshot, apps: new Map([["site", app(baseUrl)]]) });
  const response = await f.request();
  expect(response.status).toBe(503);
  expect(response.headers.has("Retry-After")).toBe(true);
});

test.each(["cloud.test", "site.test"])("internal paths cannot enter through %s", async (host) => {
  const f = fixture();
  for (const path of [
    "/_cloud/public/a",
    "/%5fcloud/public/a",
    "/x/_cloud/public",
    "/_internal/a",
    "/_cloud/ingress/traefik",
    "/_cloud/app-access",
    "/app/site/_cloud/access/site",
    "/_cloud/domain-check/_internal",
    "/_cloud/domain-check/%5Fcloud",
    "/_cloud/domain-check/a%2F_cloud%2Fpublic",
  ]) {
    if (host === "cloud.test" && ["/_cloud/app-access", "/app/site/_cloud/access/site"].includes(path)) continue;
    expect((await f.request(path, {}, host)).status).toBe(404);
  }
  expect(f.requests).toHaveLength(0);
});

test.each(["cloud.test", "site.test"])("incoming public headers cannot be forged on %s", async (host) => {
  const f = fixture();
  const body = await (
    await f.request("/", { headers: { "X-Cloud-Public-Host": "evil.test", "X-Cloud-Public-Other": "evil" } }, host)
  ).json();
  expect(body.headers["x-cloud-public-host"]).toBe(host === "site.test" ? host : undefined);
  expect(body.headers["x-cloud-public-other"]).toBeUndefined();
});

test("Cloud credential cookies are stripped and app cookies survive", async () => {
  const f = fixture();
  const body = await (
    await f.request("/", {
      headers: {
        Cookie:
          "session_token=a; pwa_session=b; pwa_device=k; pwa_pairing=s; cloud_browser=c; __Host-cloud_browser=d; __Secure-cloud-app-pwa-site-id=e; portal=f",
      },
    })
  ).json();
  expect(body.headers.cookie).toBe("portal=f");
  const empty = await (await f.request("/", { headers: { Cookie: "session_token=a" } })).json();
  expect(empty.headers.cookie).toBeUndefined();
});

test.each([
  [{ Origin: "https://other.test" }, 403],
  [{ Origin: "null" }, 403],
  [{ Origin: "https://site.test" }, 200],
  [{ "Sec-Fetch-Site": "same-site" }, 403],
  [{ "Sec-Fetch-Site": "cross-site" }, 403],
  [{ "Sec-Fetch-Site": "same-origin" }, 200],
  [{}, 200],
])("non-safe requests enforce origin and webhooks without metadata pass: %j", async (headers, status) => {
  expect((await fixture().request("/submit", { method: "POST", headers })).status).toBe(status);
});

test.each(["GET", "HEAD", "OPTIONS"])("safe method %s permits a cross-site request", async (method) => {
  expect((await fixture().request("/", { method, headers: { Origin: "https://other.test", "Sec-Fetch-Site": "cross-site" } })).status).toBe(
    200,
  );
});

test("Set-Cookie overrides app caching", async () => {
  const response = await fixture(
    () => new Response("ok", { headers: { "Set-Cookie": "portal=x; Secure", "Cache-Control": "public, max-age=600" } }),
  ).request();
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});

test("base headers default, app overrides survive, Cloud headers stay private", async () => {
  const response = await fixture(
    () => new Response("ok", { headers: { "X-Gateway-App": "spoof", "X-Gateway-Ms": "1", "X-Cloud-Test": "private" } }),
  ).request();
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  for (const header of ["X-Gateway-App", "X-Gateway-Ms", "X-Cloud-Test", "Content-Security-Policy", "X-Robots-Tag"])
    expect(response.headers.has(header)).toBe(false);
  const override = await fixture(
    () => new Response("ok", { headers: { "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "custom" } }),
  ).request();
  expect(override.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(override.headers.get("X-Content-Type-Options")).toBe("custom");
});

test("host and resolved client address reach the limiter; rejection has Retry-After", async () => {
  const f = fixture();
  f.setRateResponse(new Response("Too many requests", { status: 429, headers: { "Retry-After": "1" } }));
  const response = await f.request();
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(f.rates).toEqual([["site.test", "203.0.113.7"]]);
  expect(f.requests).toHaveLength(0);
});

test("assigned host returns the stored domain-check answer, never the path nonce", async () => {
  const f = fixture();
  f.answers.set(domainCheckKey("site.test", "nonce-value"), "separate-answer");
  const response = await f.request("/_cloud/domain-check/nonce-value");
  expect(await response.text()).toBe("separate-answer");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Type")).toBe("text/plain");
  const otherHost = await f.request("/_cloud/domain-check/nonce-value", {}, "alias.test");
  expect(otherHost.status).toBe(301);
  expect(await otherHost.text()).toBe("");
  const ordinary = await f.request("/_cloud/domain-check/expired");
  expect((await ordinary.json()).path).toBe("/_cloud/public/_cloud/domain-check/expired");
});

test("development app.localhost uses HTTP and needs no domain row", async () => {
  const f = fixture();
  f.setSnapshot({ ...f.snapshot, development: true, domains: new Map() });
  const response = await f.request("/", { method: "POST", headers: { Origin: "http://site.localhost:3000" } }, "site.localhost:3000");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.headers["x-cloud-public-host"]).toBe("site.localhost:3000");
  expect(body.headers["x-forwarded-proto"]).toBe("http");
});

describe("public site SEO and compression", () => {
  const html = "<!doctype html><html><head><title>Site</title></head><body>Grüße &amp; hello</body></html>".repeat(100);
  test.each([301, 308, 404, 410])("status %s and Location pass unchanged", async (status) => {
    const response = await fixture(() => new Response("body", { status, headers: { Location: "/next?x=%2f" } })).request();
    expect(response.status).toBe(status);
    expect(response.headers.get("Location")).toBe("/next?x=%2f");
    expect(await response.text()).toBe("body");
  });
  test("HEAD preserves representation metadata and has no body", async () => {
    const response = await fixture(
      () => new Response(null, { headers: { "Content-Type": "text/html", "Content-Length": "5000", ETag: '"site"' } }),
    ).request("/", { method: "HEAD", headers: { "Accept-Encoding": "br" } });
    expect(await response.text()).toBe("");
    expect(response.headers.get("Content-Length")).toBe("5000");
    expect(response.headers.has("Content-Encoding")).toBe(false);
  });
  test.each(["identity", "br"])("ETag revalidation works with %s", async (encoding) => {
    const f = fixture((req) => {
      const headers = { "Content-Type": "text/html", ETag: '"site"', Vary: "Accept-Language", "Cache-Control": "public, max-age=60" };
      if (req.headers.get("If-None-Match")?.replace("W/", "") === '"site"') return new Response(null, { status: 304, headers });
      return new Response(html, { headers });
    });
    const first = await f.request("/", { headers: { "Accept-Encoding": encoding } });
    const tag = first.headers.get("ETag");
    await first.arrayBuffer();
    expect(tag).toBe(encoding === "br" ? 'W/"site"' : '"site"');
    const second = await f.request("/", { headers: { "Accept-Encoding": encoding, "If-None-Match": tag ?? "" } });
    expect(second.status).toBe(304);
    expect(second.headers.get("ETag")).toBe(tag);
    expect(await second.text()).toBe("");
  });
  test("Last-Modified revalidation passes through", async () => {
    const date = "Fri, 30 Oct 2026 12:00:00 GMT";
    const response = await fixture(
      (req) =>
        new Response(null, { status: req.headers.get("If-Modified-Since") === date ? 304 : 200, headers: { "Last-Modified": date } }),
    ).request("/", { headers: { "If-Modified-Since": date } });
    expect(response.status).toBe(304);
    expect(response.headers.get("Last-Modified")).toBe(date);
  });
  test("app Vary and immutable Cache-Control survive", async () => {
    const response = await fixture(
      () =>
        new Response(html, {
          headers: { "Content-Type": "text/css", Vary: "Accept-Language", "Cache-Control": "public, max-age=31536000, immutable" },
        }),
    ).request("/asset.css", { headers: { "Accept-Encoding": "br" } });
    expect(response.headers.get("Vary")).toContain("Accept-Language");
    expect(response.headers.get("Vary")).toContain("Accept-Encoding");
    expect(response.headers.get("Vary")).toContain("Cookie");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    await response.arrayBuffer();
  });
  for (const encoding of ["br", "gzip"])
    for (const contentType of [
      "text/html",
      "text/css",
      "application/javascript",
      "application/json",
      "application/ld+json",
      "image/svg+xml",
      "application/xml",
      "application/atom+xml",
    ]) {
      test(`${encoding} compresses ${contentType} on cross-site cookie-less requests byte-identically`, async () => {
        const response = await fixture(() => new Response(html, { headers: { "Content-Type": contentType } })).request("/", {
          headers: { "Accept-Encoding": encoding, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "style" },
        });
        expect(response.headers.get("Content-Encoding")).toBe(encoding);
        const bytes = Buffer.from(await response.arrayBuffer());
        expect((encoding === "br" ? brotliDecompressSync(bytes) : gunzipSync(bytes)).toString()).toBe(html);
      });
    }
  test("Googlebot without fetch metadata receives compressed HTML", async () => {
    const response = await fixture(() => new Response(html, { headers: { "Content-Type": "text/html" } })).request("/", {
      headers: { "Accept-Encoding": "br", "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
    });
    expect(response.headers.get("Content-Encoding")).toBe("br");
    await response.arrayBuffer();
  });
  test("stripped Cloud cookies do not disable public compression", async () => {
    const response = await fixture(() => new Response(html, { headers: { "Content-Type": "text/html" } })).request("/", {
      headers: { "Accept-Encoding": "br", "Sec-Fetch-Site": "cross-site", Cookie: "session_token=x" },
    });
    expect(response.headers.get("Content-Encoding")).toBe("br");
    await response.arrayBuffer();
  });
  test("app cookie retains the existing cross-site compression rule", async () => {
    const response = await fixture(() => new Response(html, { headers: { "Content-Type": "text/html" } })).request("/", {
      headers: { "Accept-Encoding": "br", "Sec-Fetch-Site": "cross-site", Cookie: "portal=x" },
    });
    expect(response.headers.has("Content-Encoding")).toBe(false);
    expect(await response.text()).toBe(html);
  });
  test("precompressed wire bytes stay untouched", async () => {
    const bytes = brotliCompressSync(Buffer.from(html));
    const response = await fixture(
      () => new Response(bytes, { headers: { "Content-Type": "text/html", "Content-Encoding": "br" } }),
    ).request("/", { headers: { "Accept-Encoding": "gzip" } });
    expect(response.headers.get("Content-Encoding")).toBe("br");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });
  test.each(["br", "gzip"])("%s emits the first chunk before upstream finishes", async (encoding) => {
    const release = Promise.withResolvers<void>();
    let finished = false;
    const f = fixture(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode(html));
              await release.promise;
              finished = true;
              controller.enqueue(new TextEncoder().encode("end"));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/html" } },
        ),
    );
    try {
      const response = await f.request("/", { headers: { "Accept-Encoding": encoding } });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing stream");
      expect((await reader.read()).value?.byteLength).toBeGreaterThan(0);
      expect(finished).toBe(false);
      release.resolve();
      while (!(await reader.read()).done) {
        /* drain */
      }
    } finally {
      release.resolve();
    }
  });
});

test("assigned TLS domain in development preserves authority and trusted client IP", async () => {
  const f = fixture();
  f.setSnapshot({ ...f.snapshot, development: true });
  const response = await f.request(
    "/api/form",
    {
      method: "POST",
      headers: {
        Origin: "https://site.test:8443",
        "X-Forwarded-For": "192.0.2.99",
        "X-Real-IP": "192.0.2.98",
        "CF-Connecting-IP": "192.0.2.97",
        Forwarded: "for=192.0.2.96",
        "X-Forwarded-Host": "evil.test",
      },
    },
    "SITE.TEST.:8443",
  );
  expect(response.status).toBe(200);
  const { headers } = await response.json();
  expect(headers["x-cloud-public-host"]).toBe("site.test:8443");
  expect(headers["x-forwarded-host"]).toBe("site.test:8443");
  expect(headers["x-forwarded-proto"]).toBe("https");
  expect(headers["x-forwarded-for"]).toBe(client.forwardedFor);
  expect(headers["x-real-ip"]).toBe(client.address);
  expect(headers["cf-connecting-ip"]).toBeUndefined();
  expect(headers.forwarded).toBeUndefined();
});

test("public WebSocket upgrade selects the same app and strips Cloud credentials", async () => {
  const f = fixture();
  const original = globalThis.WebSocket;
  const sockets: Array<{ url: string; headers: Record<string, string> }> = [];
  Reflect.set(
    globalThis,
    "WebSocket",
    class extends EventTarget {
      constructor(url: string, options: { headers: Record<string, string> }) {
        super();
        sockets.push({ url, headers: options.headers });
      }
      close() {}
    },
  );
  try {
    const response = await f.handle(
      new Request("http://transport.test/api/other/socket?q=%2f", {
        headers: {
          Host: "site.test:8443",
          Upgrade: "websocket",
          Cookie: "session_token=x; portal=mine",
          "X-Cloud-Public-Host": "evil.test",
          "X-Cloud-Public-Extra": "evil",
          "CF-Connecting-IP": "192.0.2.1",
          Forwarded: "for=192.0.2.1",
          "X-Forwarded-For": "192.0.2.1",
          Origin: "https://site.test:8443",
        },
      }),
      { timeout: () => {}, upgrade: () => false },
      client,
    );
    expect(response?.status).toBe(500);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toContain("/_cloud/public/api/other/socket?q=%2f");
    expect(sockets[0]?.headers).toEqual({
      Cookie: "portal=mine",
      Origin: "https://site.test:8443",
      "X-Cloud-Public-Host": "site.test:8443",
      "X-Forwarded-Host": "site.test:8443",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-For": client.forwardedFor,
      "X-Real-IP": client.address,
    });
  } finally {
    Reflect.set(globalThis, "WebSocket", original);
  }
});

test.each([
  [{ Origin: "https://foreign.test" }, 403],
  [{ Origin: "https://site.test", "Sec-Fetch-Site": "same-site" }, 403],
  [{ "Sec-Fetch-Site": "cross-site" }, 403],
])("WebSocket GET rejects foreign origins and sites: %j", async (headers, status) => {
  const response = await fixture().request("/socket", { headers: { Upgrade: "websocket", ...headers } });
  expect(response.status).toBe(status);
});

test("public application clientIp and rateLimit use the trusted visitor instead of forged headers", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(1_793_404_800_000);
  const counts = new Map<string, number>();
  const send = spyOn(redis, "send").mockImplementation(async (_command, args) => {
    const key = String(args[2]);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return [count, 0, String(count)];
  });
  try {
    const publicApp = new Hono<AuthContext>();
    publicApp.use("*", rateLimit({ keyBy: "ip", limitPerSecond: 2 }));
    publicApp.get("*", (c) => c.json({ ip: clientIp(c) }));
    const f = fixture((req) => publicApp.fetch(req));
    const options = { headers: { "X-Forwarded-For": "192.0.2.99", "X-Real-IP": "192.0.2.98", "CF-Connecting-IP": "192.0.2.97" } };
    expect(await (await f.request("/api/visitor", options)).json()).toEqual({ ip: client.address });
    expect((await f.request("/api/visitor", options)).status).toBe(200);
    expect((await f.request("/api/visitor", options)).status).toBe(429);
    expect([...counts.keys()]).toEqual([expect.stringContaining(`cloud:rate-limit:2:1:ip:${client.address}:`)]);
  } finally {
    send.mockRestore();
    clock.mockRestore();
  }
});

test("an explicit default HTTPS port preserves authority and accepts the browser's canonical Origin", async () => {
  const response = await fixture().request("/submit", { method: "POST", headers: { Origin: "https://site.test" } }, "site.test:443");
  expect(response.status).toBe(200);
  expect((await response.json()).headers["x-cloud-public-host"]).toBe("site.test:443");
});

test("development Origin must include its non-default port", async () => {
  const f = fixture();
  f.setSnapshot({ ...f.snapshot, development: true, domains: new Map() });
  expect((await f.request("/submit", { method: "POST", headers: { Origin: "http://site.localhost" } }, "site.localhost:3100")).status).toBe(
    403,
  );
});

test("Authorization keeps the conservative compression rule without a cookie", async () => {
  const html = "<p>private content</p>".repeat(200);
  const response = await fixture(() => new Response(html, { headers: { "Content-Type": "text/html" } })).request("/", {
    headers: { "Accept-Encoding": "br", "Sec-Fetch-Site": "cross-site", Authorization: "Basic dXNlcjpwYXNz" },
  });
  expect(response.headers.has("Content-Encoding")).toBe(false);
  expect(await response.text()).toBe(html);
});

test("gateway-generated public responses get base headers and telemetry with the app ID", async () => {
  const f = fixture();
  const response = await f.request("/redirect", {}, "alias.test");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ appId: "site", status: 301 }));
});

test("a live domain-check path cannot bypass a WebSocket handshake's Origin rule", async () => {
  const f = fixture();
  f.answers.set(domainCheckKey("site.test", "nonce-value"), "separate-answer");
  expect(
    (await f.request("/_cloud/domain-check/nonce-value", { headers: { Upgrade: "websocket", Origin: "https://foreign.test" } })).status,
  ).toBe(403);
});

test("hosts awaiting the first durable domain snapshot get a retryable failure instead of 421", async () => {
  const f = fixture();
  f.setSnapshot({ ...f.snapshot, domains: new Map(), domainsReady: false });
  const response = await f.request();
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("5");
  expect((await f.request("/health", {}, "unknown.test")).status).toBe(200);
  expect((await f.request("/api/core", {}, "cloud.test")).status).toBe(200);
  f.setSnapshot({ ...f.snapshot, domains: new Map(), domainsReady: true });
  expect((await f.request()).status).toBe(421);
});

test.each(["cloud.test", "cloud-gateway-cloud.test", "internal.test"])("assignment cannot override Cloud routing for %s", async (host) => {
  const f = fixture();
  f.setSnapshot({
    ...f.snapshot,
    cloudHosts: cloudHostSet("https://cloud.test", ["http://cloud-gateway-cloud.test:3000", "http://internal.test:3000"], false),
    domains: new Map([[host, { host, appId: "site", redirectTo: "site.test", createdAt: "2026-10-30T00:00:00Z" }]]),
  });
  const response = await f.request("/_cloud/app-access", {}, host);
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Gateway-App")).toBe("core");
  expect((await response.json()).path).toBe("/_cloud/app-access");
  expect(f.rates).toEqual([]);
});
