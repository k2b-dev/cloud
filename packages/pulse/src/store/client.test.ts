import { expect, test } from "bun:test";
import {
  CLICKHOUSE_MAX_URL_BYTES,
  CLICKHOUSE_UUID_CHUNK_SIZE,
  clickhouseQuery,
  type QueryOptions,
  StoreQueryError,
  storeAllowlist,
} from "./client";

const marker = "REMOTE_BODY_MUST_NEVER_LEAK";
const requests: Request[] = [];
const bodies: string[] = [];
const transport: NonNullable<QueryOptions["transport"]> = async (input, init) => {
  const request = new Request(input, init);
  request.signal.throwIfAborted();
  requests.push(request);
  const query = await request.text();
  bodies.push(query);
  if (query === "redirect") throw new TypeError("Network target returned HTTP 302 redirect");
  if (query === "missing") return new Response(marker);
  if (query === "huge") return new Response("x".repeat(1024 * 1024 + 1), { headers: { "X-ClickHouse-Query-Id": "fixture" } });
  if (query === "auth") return new Response(marker, { status: 403, headers: { "X-ClickHouse-Exception-Code": "516" } });
  if (query === "rights") return new Response(marker, { status: 403, headers: { "X-ClickHouse-Exception-Code": "497" } });
  return Response.json({ data: [{ version: "26.9.19.9" }] }, { headers: { "X-ClickHouse-Query-Id": "fixture" } });
};
const options = {
  url: "http://fixture.invalid",
  user: "fixture_user",
  password: "obviously-fake-fixture-password",
  timeoutMs: 1000,
  transport,
};

test("the default transport allowlist contains only the target host or IP literal", () => {
  expect(storeAllowlist(new URL("http://clickhouse.internal:8123"))).toEqual({ hosts: new Set(["clickhouse.internal"]), networks: [] });
  expect(storeAllowlist(new URL("http://10.0.0.5:8123"))).toEqual({
    hosts: new Set(),
    networks: [{ address: "10.0.0.5", family: 4, bits: 32 }],
  });
  expect(storeAllowlist(new URL("http://[fd00::5]:8123"))).toEqual({
    hosts: new Set(),
    networks: [{ address: "fd00::5", family: 6, bits: 128 }],
  });
});
for (const query of ["redirect", "missing", "huge", "auth", "rights"])
  test(`sanitizes ${query} errors using only the exception header`, async () => {
    try {
      await clickhouseQuery({ ...options, query });
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreQueryError);
      const typed = error as StoreQueryError;
      expect(typed.kind).toBe(["auth", "rights"].includes(query) ? "clickhouse" : "unreachable");
      expect(typed.code).toBe(query === "auth" ? 516 : query === "rights" ? 497 : undefined);
      expect(String(error)).not.toContain(marker);
      expect(String(error)).not.toContain(options.password);
      expect(String(error)).not.toContain(options.url);
      expect(typed.cause).toBeUndefined();
    }
  });
test("POSTs SQL as body, parameter values as parameters and UTF8 credentials only as Basic auth", async () => {
  const password = "fake-pässword";
  expect(
    await clickhouseQuery({
      ...options,
      password,
      query: "SELECT {name:String}",
      params: { name: "fake value" },
      settings: { max_memory_usage: 1 },
    }),
  ).toEqual([{ version: "26.9.19.9" }]);
  const request = requests.at(-1)!;
  expect(new URL(request.url).searchParams.get("param_name")).toBe("fake value");
  expect(request.url).not.toContain(password);
  expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from(`${options.user}:${password}`).toString("base64")}`);
  expect(bodies.at(-1)).toBe("SELECT {name:String}");
});
test("a caller abort becomes an unreachable error without the abort reason", async () => {
  const signal = AbortSignal.abort(new Error(marker));
  await expect(clickhouseQuery({ ...options, query: "SELECT version()", signal })).rejects.toMatchObject({ kind: "unreachable" });
});

test("rejects oversized encoded parameters and settings before transport", async () => {
  for (const field of ["params", "settings"] as const) {
    const before = requests.length;
    await expect(
      clickhouseQuery({ ...options, query: "SELECT 1", [field]: { value: "é".repeat(CLICKHOUSE_MAX_URL_BYTES / 6) } }),
    ).rejects.toThrow("ClickHouse request URL exceeds the 262144-byte budget; chunk query parameters");
    expect(requests).toHaveLength(before);
  }
});
test("a full UUID and Int64 pair chunk fits the URL budget with transport overhead", async () => {
  const ids = Array.from({ length: CLICKHOUSE_UUID_CHUNK_SIZE }, () => "ffffffff-ffff-4fff-8fff-ffffffffffff");
  await clickhouseQuery({
    ...options,
    query: "SELECT 1",
    params: {
      series: `[${ids.map((id) => `'${id}'`).join(",")}]`,
      times: `[${ids.map(() => "-9223372036854775808").join(",")}]`,
      minTime: "-9223372036854775808",
      cutoff: "-9223372036854775808",
    },
    settings: { insert_deduplicate: 0, async_insert: 0 },
  });
  expect(new TextEncoder().encode(requests.at(-1)!.url).byteLength).toBeLessThan(CLICKHOUSE_MAX_URL_BYTES);
});
