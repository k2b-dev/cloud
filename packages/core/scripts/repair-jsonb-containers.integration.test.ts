import { expect, test } from "bun:test";
import { sql } from "bun";
import { decodeContainer, repairJsonbContainers } from "./repair-jsonb-containers";

test("preserves malformed JSON and scalar values instead of guessing their meaning", () => {
  for (const value of ["broken", '"text"', "null", "42", "true", "[]"]) expect(decodeContainer(value, "object")).toBeNull();
  expect(decodeContainer('{"nested":[1,2]}', "object")).toEqual({ nested: [1, 2] });
  expect(decodeContainer('[{"id":1}]', "array")).toEqual([{ id: 1 }]);
  expect(decodeContainer("{}", "array")).toBeNull();
});

test("preserves unsupported Unicode while accepting literal escapes and valid surrogate pairs", () => {
  for (const encoded of [
    '{"nested":{"value":"\\u0000"}}',
    '{"\\u0000":"key"}',
    '{"value":"\\ud800"}',
    '{"\\udfff":"key"}',
    '["\\ud800text"]',
    '{"duplicate":"\\u0000","duplicate":"safe"}',
  ])
    expect(decodeContainer(encoded, encoded.startsWith("[") ? "array" : "object")).toBeNull();
  expect(decodeContainer('{"value":"\\\\u0000"}', "object")).toEqual({ value: "\\u0000" });
  expect(decodeContainer('{"value":"\\ud83d\\ude00"}', "object")).toEqual({ value: "😀" });
});

test("CLI argument errors use sanitized usage instructions", async () => {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", new URL("./repair-jsonb-containers.ts", import.meta.url).pathname, "--private=sensitive-fixture"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(stderr).toContain("Invalid arguments. Usage:");
  expect(stderr).not.toContain("sensitive-fixture");
  expect(stderr).not.toContain("earlier batches");
});

(process.env.CLOUD_JSONB_REPAIR_TEST === "1" ? test : test.skip)(
  "repairs only allowlisted containers in bounded, repeatable batches",
  async () => {
    // This suite is for an isolated, freshly migrated fixture database only.
    const [existing] = await sql`SELECT count(*)::int AS count FROM audit.events`;
    if (existing.count !== 0) throw new Error("JSONB repair integration requires an empty audit fixture");
    const requestId = crypto.randomUUID();
    const runCli = async (apply = false) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          new URL("./repair-jsonb-containers.ts", import.meta.url).pathname,
          "--table",
          "audit.events",
          ...(apply ? ["--apply"] : []),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    };
    try {
      for (const [id, value] of [
        [1, '{"source":"fixture","large":9007199254740993}'],
        [2, '{"source":"second"}'],
        [10, '"keep scalar"'],
        [11, "broken"],
        [100, "[]"],
      ] as const) {
        await sql`INSERT INTO audit.events(id,action,outcome,request_id,metadata) OVERRIDING SYSTEM VALUE
        VALUES (${id}::bigint,'service_account_credential.create','allowed',${requestId},to_jsonb(${value}::text))`;
      }
      await sql`INSERT INTO audit.events(id,action,outcome,request_id,metadata) OVERRIDING SYSTEM VALUE
      VALUES (101,'service_account_credential.create','allowed',${requestId},'{"already":"object"}'::jsonb)`;
      expect(await repairJsonbContainers(sql, "audit.events", false, 2)).toEqual({
        candidates: 5,
        repairable: 2,
        preserved: 3,
        updated: 0,
      });
      const dryRun = await runCli();
      expect(dryRun.exitCode).toBe(0);
      expect(dryRun.stderr).toBe("");
      expect(JSON.parse(dryRun.stdout)).toMatchObject({ mode: "dry-run", candidates: 5, repairable: 2, updated: 0 });
      expect(await repairJsonbContainers(sql, "audit.events", true, 2)).toEqual({ candidates: 5, repairable: 2, preserved: 3, updated: 2 });
      expect(await repairJsonbContainers(sql, "audit.events", true, 2)).toEqual({ candidates: 3, repairable: 0, preserved: 3, updated: 0 });
      const rows =
        await sql`SELECT metadata->>'source' AS source, metadata->>'large' AS large FROM audit.events WHERE request_id=${requestId} AND metadata->>'source'='fixture'`;
      expect(rows).toEqual([{ source: "fixture", large: "9007199254740993" }]);
      for (const [id, encoded] of [
        [200, '{"invalid":"\\u0000"}'],
        [201, '{"invalid":"\\ud800"}'],
        [202, '{"literal":"\\\\u0000"}'],
        [203, '{"after":"invalid rows"}'],
        [204, '{"duplicate":"\\u0000","duplicate":"safe"}'],
        [205, '{"after":"duplicate keys"}'],
      ] as const) {
        await sql`INSERT INTO audit.events(id,action,outcome,request_id,metadata) OVERRIDING SYSTEM VALUE
          VALUES (${id}::bigint,'service_account_credential.create','allowed',${requestId},to_jsonb(${encoded}::text))`;
      }
      const continued = await runCli(true);
      expect(continued.exitCode).toBe(0);
      expect(continued.stderr).toBe("");
      expect(JSON.parse(continued.stdout)).toMatchObject({ candidates: 9, repairable: 3, preserved: 6, updated: 3 });
      expect(await repairJsonbContainers(sql, "audit.events", true, 2)).toEqual({ candidates: 6, repairable: 0, preserved: 6, updated: 0 });
      const [literal] = await sql`SELECT metadata->>'literal' AS value FROM audit.events WHERE id = 202`;
      expect(literal.value).toBe("\\u0000");
    } finally {
      await sql`DELETE FROM audit.events WHERE request_id=${requestId}`;
    }
  },
);
