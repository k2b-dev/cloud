import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { redis } from "bun";
import { Hono } from "hono";
import { valkeySuite } from "../../../../../scripts/fixtures/test-infra";
import { clientIpBucket } from "../client-ip";
import { rateLimit } from "./rate-limit";

const suite = valkeySuite();
suite("network rate budgets", () => {
  const ips = ["2001:db8:1349:1::1", "2001:0DB8:1349:0001:ffff::9", "2001:db8:1349:2::1", "192.0.2.149", "192.0.2.150"];
  const now = new Date("2026-10-22T00:00:00Z");
  const clean = async () => {
    const window = Math.floor(now.getTime() / 60_000);
    for (const ip of ips) {
      for (const key of [clientIpBucket(ip), `ip:${ip}`]) {
        await redis.del(`cloud:rate-limit:2:60:${key}:${window}`, `cloud:rate-limit:2:60:${key}:${window - 1}`);
      }
    }
  };
  beforeEach(async () => {
    setSystemTime(now);
    await clean();
  });
  afterEach(async () => {
    try {
      await clean();
    } finally {
      setSystemTime();
    }
  });
  test.each(["ip", "auto", "user"] as const)("%s shares IPv6 /64 budgets and preserves IPv4 separation", async (keyBy) => {
    const app = new Hono().use("*", rateLimit({ keyBy, limitPerSecond: 2, windowSecs: 60 })).get("/", (c) => c.text("ok"));
    const request = (ip: string) => app.request("/", { headers: { "x-forwarded-for": ip } });
    expect((await request(ips[0]!)).status).toBe(200);
    expect((await request(ips[1]!)).status).toBe(200);
    const blocked = await request(ips[1]!);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect((await request(ips[2]!)).status).toBe(200);
    expect((await request(ips[3]!)).status).toBe(200);
    expect((await request(ips[3]!)).status).toBe(200);
    expect((await request(ips[3]!)).status).toBe(429);
    expect((await request(ips[4]!)).status).toBe(200);
  });
});
