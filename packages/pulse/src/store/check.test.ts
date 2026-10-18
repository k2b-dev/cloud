import { afterEach, expect, spyOn, test } from "bun:test";
import { checkStore, supportedVersion } from "./check";
import { READ_LIMITS, READ_PROFILES } from "./setup-sql";

const clock = () => new Date("2026-10-17T12:00:00.000Z");
const options = {
  url: "http://fixture.invalid:8123",
  user: "fixture_service",
  password: "obviously-fake-password",
  prefix: "fixture_",
  clock,
};
const queries: string[] = [];
let profile: keyof typeof READ_PROFILES = "read_normal";
let reject: ((query: string) => number | undefined) | undefined;
const reply = (data: Record<string, unknown>[] = [], code?: number) =>
  code
    ? new Response("REMOTE_BODY_MUST_NEVER_LEAK", { status: 403, headers: { "X-ClickHouse-Exception-Code": String(code) } })
    : Response.json({ data }, { headers: { "X-ClickHouse-Query-Id": "fixture" } });
let mock: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
const stub = (version = "26.9.19.9") => {
  queries.length = 0;
  profile = "read_normal";
  mock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const query = String(init?.body);
        queries.push(query);
        const code = reject?.(query);
        if (code) return reply([], code);
        if (query === "SELECT version() AS version") return reply([{ version }]);
        if (query.startsWith("CREATE SETTINGS PROFILE") || /^CREATE DATABASE `fixturex_/.test(query) || query.includes("system.query_log"))
          return reply([], 497);
        if (query === "SHOW GRANTS FINAL") return reply([{ grant: "GRANT KILL QUERY ON * TO fixture_service" }]);
        if (query.startsWith("ALTER USER")) {
          const selected = Object.keys(READ_PROFILES).find((key) => query.includes(key));
          if (selected && selected in READ_PROFILES) profile = selected as keyof typeof READ_PROFILES;
        }
        if (query.startsWith("SELECT getSetting('max_memory_usage') AS memory")) return reply([{ memory: 1_000_000_000 }]);
        if (query.startsWith("SELECT getSetting")) return reply([{ ...READ_PROFILES[profile], ...READ_LIMITS }]);
        if (
          query.startsWith("SET ") ||
          query.startsWith("SELECT 1 SETTINGS") ||
          new URL(String(_input)).searchParams.has("max_memory_usage")
        )
          return reply([], 164);
        if (query.startsWith("SELECT value")) return reply([{ value: 1 }]);
        return reply();
      },
      { preconnect: fetch.preconnect },
    ),
  );
};
afterEach(() => {
  mock?.mockRestore();
  mock = undefined;
  reject = undefined;
});
test("numeric version comparison accepts 26.9+ and rejects malformed or older versions", () => {
  for (const version of ["26.9", "26.9.19.9", "26.10.1", "27.1"]) expect(supportedVersion(version)).toBe(true);
  for (const version of ["26.8.99", "25.99", "26.9evil", "unknown", "26"]) expect(supportedVersion(version)).toBe(false);
});
test("connection mode freezes time and skips all mutating probes", async () => {
  stub();
  const value = await checkStore({ ...options, mode: "connection" });
  expect(value).toMatchObject({
    ok: true,
    version: "26.9.19.9",
    checkedAt: "2026-10-17T12:00:00.000Z",
    steps: { reach: "ok", auth: "ok", version: "ok", rights: "skipped", profiles: "skipped" },
  });
  expect(queries).toEqual(["SELECT version() AS version"]);
});
test("version failure is the first failure and stops probes", async () => {
  stub("26.8.1");
  expect(await checkStore({ ...options, mode: "full" })).toMatchObject({
    ok: false,
    code: "VERSION_TOO_OLD",
    steps: { version: "failed", rights: "skipped", profiles: "skipped" },
  });
  expect(queries).toHaveLength(1);
});
test("full check validates every profile limit and all three normal override paths, then cleans up", async () => {
  stub();
  const value = await checkStore({ ...options, mode: "full" });
  expect(value).toMatchObject({ ok: true, steps: { reach: "ok", auth: "ok", version: "ok", rights: "ok", profiles: "ok" } });
  for (const setting of Object.keys(READ_LIMITS))
    expect(queries.some((query) => query.startsWith(`SELECT 1 SETTINGS ${setting} =`))).toBe(true);
  expect(queries).toContain("SET max_memory_usage = 1");
  expect(queries.at(-1)).toMatch(/^DROP SETTINGS PROFILE IF EXISTS `fixture_check_[a-f0-9]{8}`$/);
});
test("missing CREATE USER maps to a stable right and still attempts bounded cleanup", async () => {
  stub();
  reject = (query) => (query.startsWith("CREATE USER") ? 497 : undefined);
  const value = await checkStore({ ...options, mode: "full" });
  expect(value).toMatchObject({ ok: false, code: "MISSING_RIGHT:CREATE USER", steps: { rights: "failed" } });
  expect(queries.some((query) => query.startsWith("DROP USER IF EXISTS"))).toBe(true);
  expect(JSON.stringify(value)).not.toContain("REMOTE_BODY");
});
test("wrong password is auth failure, never a remote message", async () => {
  stub();
  reject = () => 516;
  expect(await checkStore({ ...options, mode: "connection" })).toMatchObject({
    ok: false,
    code: "AUTH_FAILED",
    steps: { reach: "ok", auth: "failed", version: "skipped" },
  });
});
test("a profile that permits overriding a limit is rejected", async () => {
  stub();
  const previous = mock!;
  previous.mockRestore();
  stub();
  const implementation = mock!.getMockImplementation()!;
  mock!.mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        String(init?.body).startsWith("SELECT 1 SETTINGS max_memory_usage") ? reply([{ one: 1 }]) : implementation(input, init),
      { preconnect: fetch.preconnect },
    ),
  );
  expect(await checkStore({ ...options, mode: "full" })).toMatchObject({
    ok: false,
    code: "PROFILE_MISSING:fixture_read_small",
    steps: { profiles: "failed" },
  });
});
test("admin privileges are refused and scratch objects are removed", async () => {
  stub();
  const implementation = mock!.getMockImplementation()!;
  mock!.mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        String(init?.body).startsWith("CREATE SETTINGS PROFILE") ? reply() : implementation(input, init),
      { preconnect: fetch.preconnect },
    ),
  );
  expect(await checkStore({ ...options, mode: "full" })).toMatchObject({ ok: false, code: "TOO_MANY_RIGHTS" });
  expect(queries.some((query) => query.startsWith("DROP SETTINGS PROFILE IF EXISTS"))).toBe(true);
});

test("a read profile with a changed limit counts as missing", async () => {
  stub();
  const implementation = mock!.getMockImplementation()!;
  mock!.mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const query = String(init?.body);
        if (query.startsWith("SELECT getSetting") && !query.includes("AS memory"))
          return reply([{ ...READ_PROFILES[profile], ...READ_LIMITS, max_result_rows: 1_000_000 }]);
        return implementation(input, init);
      },
      { preconnect: fetch.preconnect },
    ),
  );
  expect(await checkStore({ ...options, mode: "full" })).toMatchObject({ ok: false, code: "PROFILE_MISSING:fixture_read_small" });
});
