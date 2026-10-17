import { afterEach, expect, spyOn, test } from "bun:test";
import { clickhouseQuery, StoreQueryError } from "./client";

const marker = "REMOTE_BODY_MUST_NEVER_LEAK";
const options = {
  url: "http://fixture.invalid",
  user: "fixture_service",
  password: "obviously-fake-client-password",
  query: "SELECT version()",
  timeoutMs: 1000,
};
let mock: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
afterEach(() => mock?.mockRestore());
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
    mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => response(), { preconnect: fetch.preconnect }));
    try {
      await clickhouseQuery(options);
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
test("network errors are sanitized and fetch forbids redirects", async () => {
  let init: RequestInit | undefined;
  mock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_input: Parameters<typeof fetch>[0], options?: RequestInit) => {
        init = options;
        throw new Error(marker);
      },
      { preconnect: fetch.preconnect },
    ),
  );
  await expect(clickhouseQuery(options)).rejects.toMatchObject({ kind: "unreachable", message: "ClickHouse is unreachable" });
  expect(init?.redirect).toBe("error");
  expect(init?.signal).toBeInstanceOf(AbortSignal);
});
