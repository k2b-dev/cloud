import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { type ClientRequest, IncomingMessage, type RequestOptions } from "node:http";
import { Socket } from "node:net";
import { EMPTY_NETWORK_ALLOWLIST, parseNetworkAllowlist } from "@k2b/cloud/shared";
import { requestMetrics } from "./metrics-http";
import { fetchPrometheusMetrics } from "./metrics-scraper";

const body = "# TYPE probe gauge\nprobe 42\n";
type Reply = { status?: number; headers?: Record<string, string>; chunks?: string[]; stall?: boolean; error?: boolean };

/** Socket-free Node event/stream doubles; the transport only reads these HTTP fields. */
const fixture = (respond: (options: RequestOptions) => Reply) => {
  const sent: RequestOptions[] = [];
  let destroyed = 0;
  const request = (options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => {
    sent.push(options);
    const outgoing = new EventEmitter() as ClientRequest;
    outgoing.destroy = (() => {
      destroyed++;
      return outgoing;
    }) as ClientRequest["destroy"];
    outgoing.end = (() => {
      queueMicrotask(() => {
        const reply = respond(options);
        if (reply.error) {
          outgoing.emit("error", new Error("SECRET HEADER AND CREDENTIAL"));
          return;
        }
        const response = new IncomingMessage(new Socket());
        response.statusCode = reply.status ?? 200;
        response.headers = reply.headers ?? {};
        callback(response);
        for (const chunk of reply.chunks ?? [body]) response.push(Buffer.from(chunk));
        if (!reply.stall) response.push(null);
      });
      return outgoing;
    }) as ClientRequest["end"];
    return outgoing;
  };
  return { sent, request, destroyed: () => destroyed };
};
const privateLookup = async () => [{ address: "127.0.0.1", family: 4 }];
const local = parseNetworkAllowlist(["127.0.0.0/8"]);

test("blocked literals and DNS never reach a request factory, and failed listed DNS does not either", async () => {
  const f = fixture(() => ({}));
  for (const host of ["127.0.0.1", "[::1]", "[::ffff:127.0.0.1]", "metrics.test"]) {
    expect(
      await requestMetrics(`http://${host}/metrics`, undefined, 100, { ...f, allowlist: EMPTY_NETWORK_ALLOWLIST, lookup: privateLookup }),
    ).toMatchObject({ ok: false, error: { code: "PULSE_SCRAPE_TARGET_BLOCKED" } });
  }
  expect(
    await requestMetrics("http://metrics.test", undefined, 100, {
      ...f,
      allowlist: parseNetworkAllowlist(["metrics.test"]),
      lookup: async () => [],
    }),
  ).toMatchObject({ ok: false, error: { message: "Metrics endpoint host could not be resolved" } });
  expect(f.sent).toHaveLength(0);
});

test("allowed hosts pin one DNS answer, disable proxy agents, preserve SNI and parse samples", async () => {
  let lookups = 0;
  const f = fixture((options) => {
    expect(options.agent).toBe(false);
    expect(options).toMatchObject({ hostname: "metrics.test", servername: "metrics.test", method: "GET", path: "/metrics?q=1" });
    expect(options.headers).toMatchObject({ "User-Agent": "Pulse/1.0 metrics scraper", "Accept-Encoding": "identity" });
    expect(options).not.toHaveProperty("rejectUnauthorized", false);
    options.lookup?.("metrics.test", {}, (error, address) => {
      expect(error).toBeNull();
      expect(address).toBe("127.0.0.1");
    });
    return {};
  });
  const result = await fetchPrometheusMetrics({ endpointUrl: "https://metrics.test/metrics?q=1", bearerTokenEncrypted: null }, 100, {
    ...f,
    allowlist: parseNetworkAllowlist(["metrics.test"]),
    lookup: async () => {
      lookups++;
      return privateLookup();
    },
  });
  expect(result).toMatchObject({ ok: true, data: { metrics: [{ name: "probe", value: 42 }] } });
  expect(lookups).toBe(1);
});

test.each(["http://127.0.0.1", "http://[::ffff:127.0.0.1]", "http://[::1]"])("literal %s uses no SNI", async (url) => {
  const f = fixture((options) => {
    expect(options).toHaveProperty("servername", undefined);
    return {};
  });
  expect((await requestMetrics(url, undefined, 100, { ...f, allowlist: parseNetworkAllowlist(["127.0.0.0/8", "::1"]) })).ok).toBe(true);
});

test.each([301, 302, 303, 307, 308])("redirect status %s checks each hop and drops bearer on a different origin", async (status) => {
  const f = fixture((options) => (f.sent.length === 1 ? { status, headers: { location: "https://other.test/metrics" } } : {}));
  expect(
    (await requestMetrics("https://first.test/metrics", "Bearer secret", 100, { ...f, allowlist: local, lookup: privateLookup })).ok,
  ).toBe(true);
  expect(f.sent[0]?.headers).toHaveProperty("Authorization", "Bearer secret");
  expect(f.sent[1]?.headers).not.toHaveProperty("Authorization");
  const blocked = fixture(() => ({ status, headers: { location: "http://127.0.0.1/private" } }));
  expect(
    await requestMetrics("https://first.test", undefined, 100, {
      ...blocked,
      allowlist: parseNetworkAllowlist(["first.test"]),
      lookup: privateLookup,
    }),
  ).toMatchObject({ ok: false, error: { code: "PULSE_SCRAPE_TARGET_BLOCKED" } });
  expect(blocked.sent).toHaveLength(1);
});

test("relative redirects keep original credentials, redirect userinfo is never used, and three hops is the limit", async () => {
  const f = fixture(() => (f.sent.length < 4 ? { status: 302, headers: { location: "/next" } } : {}));
  expect(
    (await requestMetrics("http://user:p%40ss@first.test", undefined, 100, { ...f, allowlist: local, lookup: privateLookup })).ok,
  ).toBe(true);
  for (const options of f.sent) {
    expect(options.headers).toHaveProperty("Authorization", `Basic ${Buffer.from("user:p@ss").toString("base64")}`);
    expect(options).not.toHaveProperty("auth");
    expect(options.path).not.toContain("p%40ss");
  }
  const loop = fixture(() => ({ status: 302, headers: { location: "http://injected:secret@first.test/again" } }));
  expect(await requestMetrics("http://first.test", undefined, 100, { ...loop, allowlist: local, lookup: privateLookup })).toMatchObject({
    ok: false,
    error: { message: "Metrics endpoint exceeded the 3 redirect limit" },
  });
  expect(loop.sent).toHaveLength(4);
  for (const options of loop.sent) expect(options.headers).not.toHaveProperty("Authorization");
});

test("Basic credentials are dropped on cross-origin redirects and bearer takes precedence", async () => {
  const f = fixture(() => (f.sent.length === 1 ? { status: 307, headers: { location: "https://second.test" } } : {}));
  expect((await requestMetrics("http://user:pass@first.test", undefined, 100, { ...f, allowlist: local, lookup: privateLookup })).ok).toBe(
    true,
  );
  expect(f.sent[0]?.headers).toHaveProperty("Authorization", `Basic ${Buffer.from("user:pass").toString("base64")}`);
  expect(f.sent[1]?.headers).not.toHaveProperty("Authorization");
  const bearer = fixture(() => ({}));
  await requestMetrics("http://user:pass@first.test", "Bearer wins", 100, { ...bearer, allowlist: local, lookup: privateLookup });
  expect(bearer.sent[0]?.headers).toHaveProperty("Authorization", "Bearer wins");
});

test("response bytes, content encoding, HTTP status, connection errors, and headers/body deadlines are bounded", async () => {
  for (const [reply, message] of [
    [{ chunks: ["x".repeat(10 * 1024 * 1024), "x"] }, "Metrics endpoint response exceeds 10 MB"],
    [{ headers: { "content-encoding": "br" } }, "Metrics endpoint returned an unsupported content encoding"],
    [{ status: 503 }, "Metrics endpoint returned HTTP 503"],
    [{ error: true }, "Metrics endpoint connection failed"],
    [{ stall: true }, "Metrics scrape timed out after 15 seconds"],
  ] satisfies Array<[Reply, string]>) {
    const f = fixture(() => reply);
    expect(await requestMetrics("http://127.0.0.1", undefined, 20, { ...f, allowlist: local })).toMatchObject({
      ok: false,
      error: { message },
    });
    if (reply.stall || reply.chunks) expect(f.destroyed()).toBeGreaterThan(0);
  }
});

test("one deadline covers all redirect hops and slow resolution never sends a late request", async () => {
  const pending = Promise.withResolvers<Array<{ address: string; family: number }>>();
  const f = fixture(() => ({}));
  expect(
    await requestMetrics("http://metrics.test", undefined, 10, { ...f, allowlist: local, lookup: () => pending.promise }),
  ).toMatchObject({ ok: false, error: { message: "Metrics scrape timed out after 15 seconds" } });
  pending.resolve(await privateLookup());
  await Promise.resolve();
  expect(f.sent).toHaveLength(0);
  let count = 0;
  const hops = fixture(() => ({ status: 302, headers: { location: "/next" } }));
  expect(
    await requestMetrics("http://metrics.test", undefined, 20, {
      ...hops,
      allowlist: local,
      lookup: async () => {
        count++;
        if (count === 2) return new Promise(() => {});
        return privateLookup();
      },
    }),
  ).toMatchObject({ ok: false, error: { message: "Metrics scrape timed out after 15 seconds" } });
  expect(hops.sent).toHaveLength(1);
});

test("the guarded transport preserves sample and declared-family limits", async () => {
  for (const [text, message] of [
    ["# TYPE probe gauge\n" + "probe 1\n".repeat(50_001), "Metrics endpoint exceeds the 50000 sample limit"],
    ["probe 1\n", "Metrics endpoint returned no supported samples (1 skipped)"],
  ]) {
    const f = fixture(() => ({ chunks: [text!] }));
    expect(
      await fetchPrometheusMetrics({ endpointUrl: "http://127.0.0.1", bearerTokenEncrypted: null }, 1000, { ...f, allowlist: local }),
    ).toMatchObject({ ok: false, error: { message } });
  }
});
