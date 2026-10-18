import { expect, test } from "bun:test";
import { NetworkTargetBlockedError } from "@k2b/cloud/services";
import { clickhouseQuery, StoreQueryError } from "./client";

const marker = "REMOTE_BODY_MUST_NEVER_LEAK";
const options = {
  url: "http://fixture.invalid",
  user: "fixture_service",
  password: "obviously-fake-client-password",
  query: "SELECT version()",
  timeoutMs: 1000,
};
for (const [name, response, kind, code] of [
  ["missing ClickHouse header", () => new Response(marker), "unreachable", undefined],
  [
    "authentication header",
    () => new Response(marker, { status: 403, headers: { "X-ClickHouse-Exception-Code": "516" } }),
    "clickhouse",
    516,
  ],
  ["rights header", () => new Response(marker, { status: 403, headers: { "X-ClickHouse-Exception-Code": "497" } }), "clickhouse", 497],
  ["malformed JSON", () => new Response(marker, { headers: { "X-ClickHouse-Query-Id": "fixture" } }), "unreachable", undefined],
  [
    "oversized body",
    () => new Response("x".repeat(1024 * 1024 + 1), { headers: { "X-ClickHouse-Query-Id": "fixture" } }),
    "unreachable",
    undefined,
  ],
] as const)
  test(`sanitizes ${name} without a socket`, async () => {
    try {
      await clickhouseQuery({ ...options, transport: async () => response() });
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreQueryError);
      expect(error).toMatchObject({ kind, code });
      expect(String(error)).not.toContain(marker);
      expect(String(error)).not.toContain(options.password);
      expect(String(error)).not.toContain(options.query);
      expect(String(error)).not.toContain(options.url);
      expect(error instanceof Error ? error.cause : undefined).toBeUndefined();
    }
  });
for (const error of [new Error(marker), new NetworkTargetBlockedError(marker)])
  test(`${error.name} transport failures are sanitized and requests forbid redirects`, async () => {
    let init: RequestInit | undefined;
    await expect(
      clickhouseQuery({
        ...options,
        transport: async (_input, options) => {
          init = options;
          throw error;
        },
      }),
    ).rejects.toMatchObject({ kind: "unreachable", message: "ClickHouse is unreachable" });
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
