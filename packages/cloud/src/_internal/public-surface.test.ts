import { expect, spyOn, test } from "bun:test";
import { redis } from "../runtime/clients";
import { Hono } from "hono";
import { appAccess } from "../contracts/app-access";
import { PUBLIC_HOST_HEADER, PUBLIC_SURFACE_PREFIX } from "../contracts/app-domains";
import { clientIp, rateLimit } from "../server";
import { type AppDefinition, defineApp } from "./define-app";
import { inventory, publishedEntry } from "./define-app.test-fixture";
import { createPublicSurfaceHandler } from "./public-surface";
import { validateAppRegistryEntry } from "./registry-validation";

const surface = (router: Pick<Hono, "fetch"> | undefined, development = false) =>
  new Hono()
    .all(PUBLIC_SURFACE_PREFIX, createPublicSurfaceHandler(router, development))
    .all(`${PUBLIC_SURFACE_PREFIX}/*`, createPublicSurfaceHandler(router, development));
const headers = { [PUBLIC_HOST_HEADER]: "site.example.test" };

test("public routes receive their original URL, path, method, body, headers and signal without Cloud cookies", async () => {
  const controller = new AbortController();
  let seenSignal: AbortSignal | undefined;
  const router = new Hono().post("/api/message", async (c) => {
    seenSignal = c.req.raw.signal;
    return c.json({
      url: c.req.url,
      path: c.req.path,
      method: c.req.method,
      body: await c.req.text(),
      cookie: c.req.header("cookie"),
      host: c.req.header("host"),
      custom: c.req.header("x-custom"),
      publicHost: c.req.header(PUBLIC_HOST_HEADER),
      variables: c.var,
    });
  });
  const response = await surface(router).request(`http://upstream${PUBLIC_SURFACE_PREFIX}/api/message?x=1&x=2`, {
    method: "POST",
    body: "hello",
    signal: controller.signal,
    headers: {
      ...headers,
      "x-custom": "kept",
      cookie:
        "session_token=secret; site_session=own; pwa_session=p; pwa_device=d; pwa_pairing=pair; cloud_browser=b; __Host-cloud_browser=h; __Secure-cloud-app-pwa-test=x",
    },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    url: "https://site.example.test/api/message?x=1&x=2",
    path: "/api/message",
    method: "POST",
    body: "hello",
    cookie: "site_session=own",
    host: "site.example.test",
    custom: "kept",
    variables: {},
  });
  controller.abort();
  expect(seenSignal?.aborted).toBe(true);
  expect(response.headers.has("set-cookie")).toBe(false);
});

test("missing, invalid or non-normalized hosts and undeclared surfaces fail closed", async () => {
  const router = new Hono().get("*", (c) => c.text("public"));
  for (const host of [
    undefined,
    "EVIL.test",
    "evil.test.",
    "https://evil.test",
    "evil.test,other.test",
    "*.evil.test",
    "127.0.0.1",
    "evil.test/path",
    "evil.test:abc",
    "evil.test:65536",
    "evil.test:",
    "evil.test\\other",
  ]) {
    expect(
      (await surface(router).request(`${PUBLIC_SURFACE_PREFIX}/`, { headers: host ? { [PUBLIC_HOST_HEADER]: host } : {} })).status,
    ).toBe(404);
  }
  expect((await surface(undefined).request(`${PUBLIC_SURFACE_PREFIX}/`, { headers })).status).toBe(404);
});

test("the public authority retains the client port", async () => {
  const router = new Hono().get("/", (c) => c.json({ url: c.req.url, host: c.req.header("host") }));
  const response = await surface(router, true).request(`${PUBLIC_SURFACE_PREFIX}/?page=2`, {
    headers: { [PUBLIC_HOST_HEADER]: "site.localhost:3100" },
  });
  expect(await response.json()).toEqual({ url: "http://site.localhost:3100/?page=2", host: "site.localhost:3100" });
  const tls = await surface(router, true).request(`${PUBLIC_SURFACE_PREFIX}/`, {
    headers: { [PUBLIC_HOST_HEADER]: "preview.example.test:8443" },
  });
  expect(await tls.json()).toEqual({ url: "https://preview.example.test:8443/", host: "preview.example.test:8443" });
});

test("only development localhost subdomains use HTTP; root and double-slash paths keep the assigned origin", async () => {
  const router = new Hono().get("*", (c) => c.text(c.req.url));
  for (const [host, development, scheme] of [
    ["site.localhost", true, "http"],
    ["site.localhost", false, "https"],
    ["site.example.test", true, "https"],
  ] as const) {
    expect(
      await (await surface(router, development).request(PUBLIC_SURFACE_PREFIX, { headers: { [PUBLIC_HOST_HEADER]: host } })).text(),
    ).toBe(`${scheme}://${host}/`);
  }
  expect(await (await surface(router).request(`${PUBLIC_SURFACE_PREFIX}//other.test/path?q=1`, { headers })).text()).toBe(
    "https://site.example.test//other.test/path?q=1",
  );
});

test("the public router receives the Bun server binding for WebSocket upgrades", async () => {
  const binding = { server: "Bun server binding" };
  const router = new Hono().get("/ws", (c) => c.json(c.env));
  const response = await surface(router).fetch(new Request(`http://upstream${PUBLIC_SURFACE_PREFIX}/ws`, { headers }), binding);
  expect(await response.json()).toEqual(binding);
});

test("public declaration reaches the registry; the separate router bypasses Cloud app access and middleware", async () => {
  const entry = await publishedEntry(
    { ...inventory, access: appAccess.roles(["admin"]), public: true },
    async (server) => {
      const response = await server.fetch(new Request(`http://upstream${PUBLIC_SURFACE_PREFIX}/`, { headers }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("https://site.example.test/");
      expect(response.headers.has("set-cookie")).toBe(false);
    },
    (app) => app.public.get("/", (c) => c.text(c.req.url)),
  );
  expect(entry.public).toBe(true);
  expect(validateAppRegistryEntry(entry)).toBeNull();
  expect(validateAppRegistryEntry({ ...entry, public: false })).toContain("public");
  expect((await publishedEntry(inventory)).public).toBeUndefined();
});

test("adding routes without public: true fails before starting services; reserved prefixes cannot be declared", async () => {
  const app: AppDefinition = defineApp(inventory);
  app.public.get("/", (c) => c.text("public"));
  await expect(app.start({ fetch: () => new Response() })).rejects.toThrow("without declaring public: true");
  for (const route of [
    "/_cloud/public",
    "/_cloud/public/*",
    "//_cloud//public/",
    "/%5fcloud/public",
    "/x/../_cloud/public",
    "/%5fcloud%2fpublic",
  ]) {
    expect(() => defineApp({ ...inventory, routes: [route] })).toThrow("reserved /_cloud/public");
  }
  expect(() => defineApp({ ...inventory, routes: ["/_cloud/app-access"] })).not.toThrow();
});

test("clientIp and rateLimit work on public routes without Cloud context", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-30T12:00:00.000Z"));
  const calls: string[][] = [];
  const send = spyOn(redis, "send").mockImplementation(async (_command, args) => {
    calls.push(args);
    return [calls.length, 0, String(calls.length)];
  });
  try {
    const router = new Hono()
      .use(rateLimit({ keyBy: "ip", limitPerSecond: 1, windowSecs: 1 }))
      .get("/", (c) => c.json({ ip: clientIp(c), variables: c.var }));
    const requestHeaders = { ...headers, "X-Forwarded-For": "203.0.113.8", "X-Real-IP": "203.0.113.8" };
    const first = await surface(router).request(`${PUBLIC_SURFACE_PREFIX}/`, { headers: requestHeaders });
    expect(await first.json()).toEqual({ ip: "203.0.113.8", variables: {} });
    const second = await surface(router).request(`${PUBLIC_SURFACE_PREFIX}/`, { headers: requestHeaders });
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("1");
    expect(calls[0]?.[2]).toContain("ip:203.0.113.8");
  } finally {
    send.mockRestore();
    clock.mockRestore();
  }
});

test("public: true retains normal lifecycle startup, settings and Sync", async () => {
  let started = false;
  await publishedEntry({ ...inventory, public: true }, undefined, undefined, {
    lifecycle: {
      start: async (context) => {
        started = true;
        expect(context.sync).toBeDefined();
        expect(context.settings.get).toBeFunction();
        expect(context.settings.set).toBeFunction();
      },
    },
  });
  expect(started).toBe(true);
  expect(defineApp({ ...inventory, public: true }).settings).toBeDefined();
});
