import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { redis } from "../../runtime/clients";
import * as proxyReturn from "./proxy-return";

const suite = suiteFor("valkey");

suite("proxy auth return tokens", () => {
  test("creates and consumes one-time return tokens", async () => {
    const token = await proxyReturn.create({
      clientId: "proxy-client",
      url: "https://protected.example/path?query=1",
      ttlSeconds: 30,
    });

    expect(token).toBeTruthy();
    expect(await redis.get(`auth:proxy-return:${token}`)).toBeNull();
    const cacheKey = `auth:proxy-return:${createHash("sha256").update(token!).digest("hex")}`;
    expect(await redis.exists(cacheKey)).toBe(true);
    expect(await redis.ttl(cacheKey)).toBeGreaterThan(0);
    expect(await redis.ttl(cacheKey)).toBeLessThanOrEqual(30);
    const consumed = await proxyReturn.consume({ token: token! });
    expect(consumed).toEqual({
      clientId: "proxy-client",
      url: "https://protected.example/path?query=1",
    });
    expect(await proxyReturn.consume({ token: token! })).toBeNull();
  });

  test("rejects non-http return URLs", async () => {
    expect(await proxyReturn.create({ clientId: "proxy-client", url: "javascript:alert(1)" })).toBeNull();
  });
});
