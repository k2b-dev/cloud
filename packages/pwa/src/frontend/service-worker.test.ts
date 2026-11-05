import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { PwaStaticAsset } from "@k2b/cloud/contracts/pwa-assets";
import source from "./service-worker.js" with { type: "text" };

const origin = "https://cloud.test";
const current = "/chat/_ssr/0123456789abcdef/chunk-build.js";
const old = "/chat/_ssr/fedcba9876543210/chunk-build.js";
const asset = (url = current, body = "export const value = 1;"): PwaStaticAsset => ({
  url,
  sha256: createHash("sha256").update(body).digest("hex"),
  bytes: Buffer.byteLength(body),
  type: "text/javascript",
});
const immutable = (body = "export const value = 1;", headers: Record<string, string> = {}) =>
  new Response(body, {
    headers: { "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "text/javascript", ...headers },
  });

type Listener = (event: Record<string, unknown>) => void;
function storage() {
  const entries = new Map<string, Response>();
  const key = (request: Request | string) => (typeof request === "string" ? request : request.url);
  const cache = {
    keys: async () => [...entries.keys()].map((url) => new Request(url)),
    match: async (request: Request | string) => entries.get(key(request))?.clone(),
    put: async (request: Request | string, response: Response) => {
      entries.set(key(request), response.clone());
    },
    delete: async (request: Request | string) => entries.delete(key(request)),
  };
  return { entries, cache, open: async () => cache };
}
function worker(options: { assets?: PwaStaticAsset[]; caches?: ReturnType<typeof storage>; limit?: number } = {}) {
  const caches = options.caches ?? storage();
  const listeners = new Map<string, Listener>();
  let network: (request: Request) => Promise<Response> = async () => immutable();
  let calls = 0;
  const fetch = (request: Request) => {
    calls++;
    return network(request);
  };
  const self = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  new Function("self", "caches", "fetch", "location", "crypto", "OFFLINE_HTML", "STATIC_ASSETS", "CACHE_BYTES", source)(
    self,
    caches,
    fetch,
    { origin },
    crypto,
    "offline page",
    options.assets ?? [asset()],
    options.limit ?? 16 * 1024 * 1024,
  );
  const run = async (type: string, event: Record<string, unknown>) => {
    const pending: Promise<unknown>[] = [];
    let answer: Promise<Response> | undefined;
    listeners.get(type)!({
      ...event,
      respondWith: (value: Promise<Response>) => {
        answer = value;
      },
      waitUntil: (value: Promise<unknown>) => pending.push(value),
    });
    const response = await answer;
    await Promise.all(pending);
    return response;
  };
  return {
    caches,
    calls: () => calls,
    network: (next: typeof network) => {
      network = next;
    },
    activate: () => run("activate", {}),
    fetch: (url = current, mode = "cors", method = "GET") => run("fetch", { request: { url: new URL(url, origin).href, mode, method } }),
  };
}

test("a versioned asset survives an HTTP-cache clear and a worker restart while offline", async () => {
  const first = worker();
  expect(await (await first.fetch())!.text()).toBe("export const value = 1;");
  expect(first.caches.entries.size).toBe(1);
  const restarted = worker({ caches: first.caches });
  restarted.network(async () => {
    throw new Error("offline");
  });
  expect(await (await restarted.fetch())!.text()).toBe("export const value = 1;");
  expect(restarted.calls()).toBe(0);
});

test("HTML, API, unversioned assets, cross-origin, query variants and non-GET requests bypass CacheStorage", async () => {
  const sw = worker();
  for (const url of ["/pwa/chat", "/api/chat/messages", "/public/fonts/plex.woff2", `${current}?extra=1`, `https://other.test${current}`]) {
    expect(await sw.fetch(url)).toBeUndefined();
  }
  expect(await sw.fetch(current, "cors", "POST")).toBeUndefined();
  sw.network(async () => new Response("private page", { headers: { "Cache-Control": "private, no-store" } }));
  expect(await (await sw.fetch("/pwa/chat", "navigate"))!.text()).toBe("private page");
  expect(sw.caches.entries.size).toBe(0);
  sw.network(async () => {
    throw new Error("offline");
  });
  expect(await (await sw.fetch("/pwa/chat", "navigate"))!.text()).toBe("offline page");
});

test.each(["private, immutable", "public, no-store, immutable", "public, max-age=60"])("does not cache %s", async (control) => {
  const sw = worker();
  sw.network(async () => immutable(undefined, { "Cache-Control": control }));
  expect((await sw.fetch())!.status).toBe(200);
  expect(sw.caches.entries.size).toBe(0);
});

test("Set-Cookie and non-200 responses never enter the cache", async () => {
  const sw = worker();
  sw.network(async () => immutable(undefined, { "Set-Cookie": "secret=value" }));
  await sw.fetch();
  sw.network(async () => new Response("failure", { status: 503 }));
  await sw.fetch();
  expect(sw.caches.entries.size).toBe(0);
});

test.each(["evil()", "export const value = 2;", "export const value = 1;extra"])(
  "rejects a planted cache body (%s), including forged digest headers",
  async (body) => {
    const sw = worker();
    await sw.caches.cache.put(origin + current, immutable(body, { "X-SHA256": asset().sha256 }));
    expect(await (await sw.fetch())!.text()).toBe("export const value = 1;");
    expect(sw.calls()).toBe(1);
  },
);

test("a planted entry cannot supply MIME, encoding, redirect or other executable headers", async () => {
  const sw = worker();
  await sw.caches.cache.put(
    origin + current,
    immutable(undefined, {
      "Content-Type": "text/html",
      "Content-Encoding": "gzip",
      Location: "/evil",
      Refresh: "0;url=/evil",
    }),
  );
  const result = (await sw.fetch())!;
  expect(result.headers.get("Content-Type")).toBe("text/javascript");
  for (const header of ["Content-Encoding", "Location", "Refresh"]) expect(result.headers.has(header)).toBe(false);
});

test("a poisoned entry is removed even when network recovery fails", async () => {
  const sw = worker();
  await sw.caches.cache.put(origin + current, immutable("evil()"));
  sw.network(async () => {
    throw new Error("offline");
  });
  await expect(sw.fetch()).rejects.toThrow("offline");
  expect(sw.caches.entries.size).toBe(0);
});

test("activation purges retired releases and unregistered apps without discarding current assets", async () => {
  const sw = worker();
  await sw.caches.cache.put(origin + old, immutable());
  await sw.caches.cache.put(origin + "/gone/_ssr/0123456789abcdef/chunk.js", immutable());
  await sw.fetch();
  const next = worker({ caches: sw.caches });
  await next.activate();
  expect([...next.caches.entries.keys()]).toEqual([origin + current]);
});

test("a response from a different build at a pinned URL is refused", async () => {
  const sw = worker();
  sw.network(async () => immutable("export const value = 2;"));
  expect((await sw.fetch())!.type).toBe("error");
  expect(sw.caches.entries.size).toBe(0);
});

test("concurrent downloads evict oldest writes within the byte cap", async () => {
  const first = asset();
  const second = asset("/pwa/_ssr/0123456789abcdef/entry.js");
  const sw = worker({ assets: [first, second], limit: first.bytes });
  await Promise.all([sw.fetch(first.url), sw.fetch(second.url)]);
  expect(sw.caches.entries.size).toBe(1);
});

test("successful network responses must match the pinned build even when they cannot be cached", async () => {
  const sw = worker();
  sw.network(async () => immutable("another release's stylesheet", { "Cache-Control": "no-cache" }));
  expect((await sw.fetch())!.type).toBe("error");
  expect(sw.caches.entries.size).toBe(0);
});

test("an oversized streaming response fails promptly without an unread clone branch", async () => {
  const sw = worker();
  let cancelled = false;
  sw.network(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(asset().bytes + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Cache-Control": "public, immutable" } },
      ),
  );
  const response = await sw.fetch();
  expect(response!.type).toBe("error");
  expect(cancelled).toBe(true);
}, 1000);

test("activation removes oversized or private planted bodies before accounting for retained bytes", async () => {
  const sw = worker();
  await sw.caches.cache.put(origin + current, immutable("x".repeat(250_000)));
  await sw.activate();
  expect(sw.caches.entries.size).toBe(0);
  await sw.caches.cache.put(origin + current, immutable(undefined, { "Cache-Control": "private, immutable" }));
  await sw.activate();
  expect(sw.caches.entries.size).toBe(0);
});

test("a new document may use its current stylesheet before the worker catalog updates, but never a retired stylesheet version", async () => {
  const sw = worker();
  sw.network(async () => new Response("new stylesheet", { headers: { "Cache-Control": "public, immutable" } }));
  expect(await (await sw.fetch("/public/global.css?v=new-build"))!.text()).toBe("new stylesheet");
  sw.network(async () => new Response("new stylesheet", { headers: { "Cache-Control": "no-cache" } }));
  expect((await sw.fetch("/public/global.css?v=retired-build"))!.type).toBe("error");
  expect(sw.caches.entries.size).toBe(0);
});
