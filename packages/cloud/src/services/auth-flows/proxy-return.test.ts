import { expect, test } from "bun:test";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import * as proxyReturn from "./proxy-return";

const suite = databaseSuite();

suite("proxy auth return tokens", () => {
  test("creates and consumes one-time return tokens", async () => {
    const token = await proxyReturn.create({
      clientId: "proxy-client",
      url: "https://protected.example/path?query=1",
      ttlSeconds: 30,
    });

    expect(token).toBeTruthy();
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
