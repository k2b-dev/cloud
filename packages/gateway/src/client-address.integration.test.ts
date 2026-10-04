import { expect, spyOn, test } from "bun:test";
import { rateLimit } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import { resolveClientAddress, trustedProxySet } from "./client-address";
import { createProxyStats, proxyRequest } from "./proxy";
import { buildRouteTable } from "./trie";

const suite = suiteFor("valkey");

/** An app with the platform's per-IP rate limit, behind a gateway that trusts the given proxies. */
const stack = (trusted: string[]) => {
  const app = new Hono().use("*", rateLimit({ keyBy: "ip", limitPerSecond: 1, windowSecs: 60 })).get("/limited", (c) => c.text("ok"));
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const table = buildRouteTable([{ prefix: "/", appId: "limited", baseUrl: upstream.url.href }]);
  const proxies = trustedProxySet(trusted);
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req, server) =>
      proxyRequest(
        req,
        table,
        createProxyStats(),
        () => {},
        resolveClientAddress(req.headers.get("x-forwarded-for"), server.requestIP(req)?.address ?? null, proxies),
      ),
  });
  // The test process is the reverse proxy: it connects from loopback and names the client.
  const request = async (client: string) =>
    (await fetch(new URL("/limited", gateway.url), { headers: { "X-Forwarded-For": client } })).status;
  return {
    request,
    stop: async () => {
      await gateway.stop(true);
      await upstream.stop(true);
    },
  };
};

suite("gateway client address and app rate limits", () => {
  test("two clients behind one trusted proxy get separate rate-limit buckets", async () => {
    const telemetry = spyOn(services, "publishRequestTelemetry").mockImplementation(() => {});
    const proxy = stack(["127.0.0.1"]);
    try {
      const [first, second] = [uniqueCallerAddress(), uniqueCallerAddress()];
      expect(await proxy.request(first)).toBe(200);
      expect(await proxy.request(first)).toBe(429);
      expect(await proxy.request(second)).toBe(200);
    } finally {
      await proxy.stop();
      telemetry.mockRestore();
    }
  });

  test("a peer that is not a trusted proxy cannot pick a fresh bucket through the header", async () => {
    const telemetry = spyOn(services, "publishRequestTelemetry").mockImplementation(() => {});
    const direct = stack([]);
    try {
      // Both requests count against the peer's own address, whatever they claim.
      await direct.request(uniqueCallerAddress());
      expect(await direct.request(uniqueCallerAddress())).toBe(429);
    } finally {
      await direct.stop();
      telemetry.mockRestore();
    }
  });
});
