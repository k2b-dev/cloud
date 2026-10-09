import { expect, test } from "bun:test";
import { request } from "node:http";
import { resolvePublicNetworkAddresses } from "./network-security";
import { type PublicHttpInput, requestPublicHttps } from "./public-http";

const base = { method: "GET", headers: { authorization: "fixture-token" }, maxBytes: 1024, signal: new AbortController().signal };
test("public HTTP blocks local addresses and credentials before opening a connection", async () => {
  for (const url of ["http://example.com", "https://user:pass@example.com"])
    await expect(requestPublicHttps({ ...base, url })).rejects.toThrow("HTTPS_REQUIRED");
  for (const url of [
    "https://127.0.0.1",
    "https://[::1]",
    "https://169.254.169.254",
    "https://localhost",
    "https://metadata.google.internal",
    "https://db.cluster.internal",
  ])
    await expect(requestPublicHttps({ ...base, url })).rejects.toThrow(/not allowed|private or reserved/);
  await expect(requestPublicHttps({ ...base, url: "https://example.com", maxBytes: 0.5 })).rejects.toThrow("INVALID_BYTE_LIMIT");
});
test("a public name with any private DNS answer never opens a connection", async () => {
  let requests = 0;
  for (const answers of [
    [{ address: "10.0.0.7", family: 4 }],
    [
      { address: "93.184.215.14", family: 4 },
      { address: "::ffff:169.254.169.254", family: 6 },
    ],
  ])
    await expect(
      requestPublicHttps(
        { ...base, url: "https://preview.example.com/page" },
        {
          resolve: (hostname) => resolvePublicNetworkAddresses(hostname, async () => answers),
          request: (options, callback) => {
            requests++;
            return request(options, callback);
          },
        },
      ),
    ).rejects.toThrow("private or reserved");
  expect(requests).toBe(0);
});
test("pinned transport preserves HTTP failures and bytes, never redirects, and limits responses", async () => {
  const received: Array<{ path: string; authorization: string | null; host: string | null }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      received.push({ path, authorization: req.headers.get("authorization"), host: req.headers.get("host") });
      if (path === "/redirect")
        return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/secret", "set-cookie": "secret" } });
      if (path === "/big") return new Response("x".repeat(1025));
      if (path === "/encoded") return new Response("compressed", { headers: { "content-encoding": "gzip" } });
      return new Response(await req.arrayBuffer(), {
        status: 429,
        headers: { "retry-after": "3", "set-cookie": "secret", "x-private": "secret" },
      });
    },
  });
  let requests = 0;
  const send = (path: string, extra: Partial<PublicHttpInput> = {}) =>
    requestPublicHttps(
      { ...base, url: `https://api.example.com:${server.port}${path}`, ...extra },
      {
        resolve: async (hostname) => {
          expect(hostname).toBe("api.example.com");
          return [{ address: "127.0.0.1", family: 4 }];
        },
        request: (options, callback) => {
          requests++;
          expect(options.hostname).toBe("127.0.0.1");
          expect(options.servername).toBe("api.example.com");
          expect(options.rejectUnauthorized).toBe(true);
          // Local HTTP fixture exercises the byte transport; production uses node:https.
          return request({ ...options, protocol: "http:" }, callback);
        },
      },
    );
  try {
    const result = await send("/echo", { method: "POST", body: new Uint8Array([0, 255, 128]) });
    expect(result.status).toBe(429);
    expect(result.body).toEqual(new Uint8Array([0, 255, 128]));
    expect(result.headers["retry-after"]).toBe("3");
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.headers["x-private"]).toBeUndefined();
    expect(received[0]).toEqual({ path: "/echo", authorization: "fixture-token", host: `api.example.com:${server.port}` });
    expect((await send("/redirect")).status).toBe(302);
    expect(requests).toBe(2);
    await expect(send("/big")).rejects.toThrow("HTTP_FAILED");
    await expect(send("/encoded")).rejects.toThrow("HTTP_FAILED");
    expect(requests).toBe(4);
  } finally {
    await server.stop(true);
  }
});
test("cancellation bounds even a stalled DNS lookup", async () => {
  const abort = new AbortController();
  let sent = false;
  const result = requestPublicHttps(
    { ...base, url: "https://api.example.com", signal: abort.signal },
    {
      resolve: () => new Promise(() => {}),
      request: (options, callback) => {
        sent = true;
        return request(options, callback);
      },
    },
  );
  abort.abort();
  await expect(result).rejects.toThrow("HTTP_CANCELLED");
  expect(sent).toBe(false);
});
