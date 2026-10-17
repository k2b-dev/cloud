import { afterAll, expect, test } from "bun:test";
import { clickhouseQuery, StoreQueryError } from "./client";

const marker = "REMOTE_BODY_MUST_NEVER_LEAK";
const requests: Request[] = [];
const bodies: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    requests.push(request);
    const query = await request.text();
    bodies.push(query);
    if (query === "redirect") return Response.redirect(`${new URL(request.url).origin}/`, 302);
    if (query === "missing") return new Response(marker);
    if (query === "huge") return new Response("x".repeat(1024 * 1024 + 1), { headers: { "X-ClickHouse-Query-Id": "fixture" } });
    if (query === "auth") return new Response(marker, { status: 403, headers: { "X-ClickHouse-Exception-Code": "516" } });
    if (query === "rights") return new Response(marker, { status: 403, headers: { "X-ClickHouse-Exception-Code": "497" } });
    return Response.json({ data: [{ version: "26.9.19.9" }] }, { headers: { "X-ClickHouse-Query-Id": "fixture" } });
  },
});
afterAll(() => server.stop(true));
const options = { url: server.url.origin, user: "fixture_user", password: "obviously-fake-fixture-password", timeoutMs: 1000 };
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
      expect(String(error)).not.toContain(server.url.origin);
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
