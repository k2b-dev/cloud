import { expect, test } from "bun:test";
import { assertRunUrl, parseServerTiming, postgresArgs, propsBytes, slowestPlan } from "./measure";

test("host clients refuse other ports, hosts and databases", () => {
  expect(assertRunUrl("postgresql://ipa:ipa@127.0.0.1:4211/cloud_perf_test", 4211, "postgresql:", "cloud_perf_test")).toContain(":4211/");
  for (const url of [
    "postgresql://127.0.0.1:3000/cloud_perf_test",
    "postgresql://localhost:4211/cloud_perf_test",
    "postgresql://127.0.0.1:4212/cloud_perf_test",
    "postgresql://127.0.0.1:4211/cloud_dev",
    "postgresql://db:4211/cloud_perf_test",
  ])
    expect(() => assertRunUrl(url, 4211, "postgresql:", "cloud_perf_test")).toThrow();
});
test("SSR counts decoded props bytes and Server-Timing phases", async () => {
  expect(
    await propsBytes(
      '<solid-island data-props="{&quot;x&quot;:&quot;ä&quot;}"></solid-island><solid-client data-props="abc"></solid-client>',
    ),
  ).toBe(Buffer.byteLength('{"x":"ä"}') + 3);
  expect(parseServerTiming("auth;dur=1.25, ssr_data;dur=3.5")).toEqual({ auth: 1.25, ssr_data: 3.5 });
});
test("auto_explain parser keeps the slowest complete JSON plan and excludes observer queries", () => {
  const record = (query: string, duration: number) =>
    `2026 LOG: duration: ${duration} ms plan:\n${JSON.stringify({ "Query Text": query, Plan: { "Node Type": "Seq Scan", "Actual Total Time": duration, "Shared Hit Blocks": 12, "Shared Read Blocks": 2, Filter: 'text = \'{"foo": "bar"}\'' } }, null, 2)}\n`;
  const result = slowestPlan(
    record("SELECT * FROM mail.message_contents", 12) +
      record("SELECT pg_reload_conf()", 50) +
      record("SELECT * FROM mail.conversations", 20),
    [],
  );
  expect(result).toMatchObject({
    query: "SELECT * FROM mail.conversations",
    matched: false,
    durationMs: 20,
    node: "Seq Scan",
    hits: 12,
    reads: 2,
  });
  expect(slowestPlan("no plan", [])).toBeNull();
});

test("auto_explain prefers the slowest matching window statement over slower background plans", () => {
  const record = (query: string, duration: number) =>
    `LOG: duration: ${duration} ms plan:\n${JSON.stringify({ "Query Text": query, Plan: { "Node Type": "Index Scan", "Actual Total Time": duration } })}\n`;
  const query = "SELECT * FROM mail.conversations WHERE id = $1";
  const log = record("SELECT * FROM auth.users", 90) + record(query, 12) + record(`${query}\n ; \n`, 20);
  const statements = [{ query: "  SELECT  * FROM mail.conversations\nWHERE id = $1;  " }];
  expect(slowestPlan(log, statements)).toMatchObject({ query, durationMs: 20, matched: true });
  expect(slowestPlan(log, [{ query: "SELECT * FROM mail.conversations WHERE id = $2" }])).toMatchObject({
    query: "SELECT * FROM auth.users",
    durationMs: 90,
    matched: false,
  });
  // Matching must happen before any display truncation: these differ after 1000 characters.
  const long = `SELECT ${"column, ".repeat(150)}last FROM mail.conversations WHERE id = $1`;
  expect(slowestPlan(record(long.replace("$1", "$2"), 90) + record(long, 12), [{ query: long }])).toMatchObject({
    query: long,
    durationMs: 12,
    matched: true,
  });
});

test("explain threshold remains reloadable while other requested server instrumentation is enabled", () => {
  expect(postgresArgs).toContain("shared_preload_libraries=pg_stat_statements,auto_explain");
  expect(postgresArgs).toContain("pg_stat_statements.track=all");
  expect(postgresArgs).toContain("auto_explain.log_analyze=on");
  expect(postgresArgs).toContain("auto_explain.log_buffers=on");
  expect(postgresArgs).not.toContain("auto_explain.log_min_duration=-1");
});
