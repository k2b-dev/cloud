import { describe, expect, test } from "bun:test";
import { EMPTY_NETWORK_ALLOWLIST, parseNetworkAllowlist } from "@k2b/cloud/shared";
import { resolvePulseMessages } from "../messages";
import { requestMetrics } from "./metrics-http";
import { fetchPrometheusMetrics } from "./metrics-scraper";

const metrics = "# TYPE probe gauge\nprobe 42\n";
const local = parseNetworkAllowlist(["127.0.0.0/8"]);
const blocked = {
  ok: false,
  // The message names the refused host first, then how a Cloud admin releases it.
  error: {
    code: "PULSE_SCRAPE_TARGET_BLOCKED",
    status: 400,
    message: expect.stringContaining(resolvePulseMessages("en").t.scrapeTargetBlocked),
  },
} as const;

describe("guarded Pulse metrics transport", () => {
  test("default refuses literals, mapped IPv4 and private DNS without sending requests; explicit entries allow parsed metrics", async () => {
    let received = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        received++;
        return new Response(metrics);
      },
    });
    const lookup = async () => [{ address: "127.0.0.1", family: 4 }];
    try {
      for (const host of ["127.0.0.1", "[::1]", "[::ffff:127.0.0.1]", "metrics.test"]) {
        const endpointUrl = `http://${host}:${server.port}/metrics`;
        expect(
          await fetchPrometheusMetrics({ endpointUrl, bearerTokenEncrypted: null }, 1000, { allowlist: EMPTY_NETWORK_ALLOWLIST, lookup }),
        ).toEqual(blocked);
      }
      expect(received).toBe(0);
      for (const host of ["127.0.0.1", "[::ffff:127.0.0.1]", "metrics.test"]) {
        const result = await fetchPrometheusMetrics(
          { endpointUrl: `http://${host}:${server.port}/metrics`, bearerTokenEncrypted: null },
          1000,
          {
            allowlist: host === "metrics.test" ? parseNetworkAllowlist(["metrics.test"]) : local,
            lookup,
          },
        );
        expect(result).toMatchObject({ ok: true, data: { metrics: [{ name: "probe", value: 42 }] } });
      }
      expect(received).toBe(3);
      expect(
        await requestMetrics(`http://metrics.test:${server.port}`, undefined, 1000, {
          allowlist: parseNetworkAllowlist(["metrics.test"]),
          lookup: async () => {
            throw new Error("secret DNS error");
          },
        }),
      ).toMatchObject({ ok: false, error: { message: "Metrics endpoint host could not be resolved" } });
      expect(received).toBe(3);
    } finally {
      server.stop(true);
    }
  });

  test("IPv6 loopback requires an IPv6 entry", async () => {
    let server: ReturnType<typeof Bun.serve>;
    try {
      server = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response(metrics) });
    } catch (error) {
      if (error instanceof Error && "code" in error && ["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(String(error.code))) return;
      throw error;
    }
    try {
      const source = { endpointUrl: `http://[::1]:${server.port}/metrics`, bearerTokenEncrypted: null };
      expect(await fetchPrometheusMetrics(source, 1000, { allowlist: EMPTY_NETWORK_ALLOWLIST })).toEqual(blocked);
      expect(await fetchPrometheusMetrics(source, 1000, { allowlist: parseNetworkAllowlist(["::1/128"]) })).toMatchObject({
        ok: true,
        data: { metrics: [{ name: "probe", value: 42 }] },
      });
    } finally {
      server.stop(true);
    }
  });

  test("revalidates redirects before connecting and strips credentials across origins", async () => {
    const received: Array<string | null> = [];
    const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        received.push(req.headers.get("authorization"));
        return new Response(metrics);
      },
    });
    let target = `http://other.test:${destination.port}/metrics`;
    const sent: Array<string | null> = [];
    const origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        sent.push(req.headers.get("authorization"));
        return Response.redirect(target, 302);
      },
    });
    const lookup = async () => [{ address: "127.0.0.1", family: 4 }];
    try {
      const url = `http://allowed.test:${origin.port}/metrics`;
      const deps = { allowlist: parseNetworkAllowlist(["allowed.test"]), lookup };
      expect(await requestMetrics(url, "Bearer private-token", 1000, deps)).toEqual(blocked);
      expect(received).toEqual([]);
      expect(sent).toEqual(["Bearer private-token"]);
      expect(await requestMetrics(url, "Bearer private-token", 1000, { allowlist: local, lookup })).toEqual({ ok: true, data: metrics });
      expect(received).toEqual([null]);
      target = `http://allowed.test:${origin.port}/again`;
      sent.length = 0;
      expect(await requestMetrics(url, "Bearer private-token", 1000, deps)).toMatchObject({
        ok: false,
        error: { message: "Metrics endpoint exceeded the 3 redirect limit" },
      });
      expect(sent).toEqual(Array(4).fill("Bearer private-token"));
      target = "file:///ignored";
      expect(await requestMetrics(url, undefined, 1000, deps)).toMatchObject({
        ok: false,
        error: { message: "Metrics endpoint must use HTTP or HTTPS" },
      });
    } finally {
      origin.stop(true);
      destination.stop(true);
    }
  });

  test("preserves Basic URL credentials, gives bearer precedence, and follows relative redirects", async () => {
    const auth: Array<string | null> = [];
    let redirect = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        auth.push(req.headers.get("authorization"));
        expect(req.headers.get("user-agent")).toBe("Pulse/1.0 metrics scraper");
        expect(req.headers.get("accept-encoding")).toBe("identity");
        return redirect && new URL(req.url).pathname === "/first"
          ? new Response(null, { status: 307, headers: { location: "/metrics" } })
          : new Response(metrics);
      },
    });
    try {
      const url = `http://user:p%40ss@127.0.0.1:${server.port}/first`;
      expect(await requestMetrics(url, undefined, 1000, { allowlist: local })).toEqual({ ok: true, data: metrics });
      expect(auth).toEqual([`Basic ${Buffer.from("user:p@ss").toString("base64")}`]);
      redirect = true;
      expect(await requestMetrics(url, "Bearer wins", 1000, { allowlist: local })).toEqual({ ok: true, data: metrics });
      expect(auth.slice(1)).toEqual(["Bearer wins", "Bearer wins"]);
    } finally {
      server.stop(true);
    }
  });

  test("bounds bytes, rejects encoded bodies and retains HTTP status errors", async () => {
    let response = () => new Response("x".repeat(10 * 1024 * 1024 + 1));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => response() });
    const run = () => requestMetrics(`http://127.0.0.1:${server.port}`, undefined, 1000, { allowlist: local });
    try {
      expect(await run()).toMatchObject({ ok: false, error: { message: "Metrics endpoint response exceeds 10 MB" } });
      response = () => new Response("encoded", { headers: { "content-encoding": "gzip" } });
      expect(await run()).toMatchObject({ ok: false, error: { message: "Metrics endpoint returned an unsupported content encoding" } });
      response = () => new Response("oops", { status: 503 });
      expect(await run()).toMatchObject({ ok: false, error: { message: "Metrics endpoint returned HTTP 503" } });
    } finally {
      server.stop(true);
    }
  });

  test("deadline covers DNS and never dispatches a request after resolution finishes late", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return new Response(metrics);
      },
    });
    const pending = Promise.withResolvers<Array<{ address: string; family: number }>>();
    try {
      expect(
        await requestMetrics(`http://metrics.test:${server.port}`, undefined, 20, { allowlist: local, lookup: () => pending.promise }),
      ).toMatchObject({ ok: false, error: { message: "Metrics scrape timed out after 15 seconds" } });
      pending.resolve([{ address: "127.0.0.1", family: 4 }]);
      await Promise.resolve();
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});
