import { expect, test } from "bun:test";
import { BASE_SCHEMA_VERSIONS, baseStoreNames, baseTtlStatements, READ_VIEWS } from "./base-schema";

const id = "11111111-1111-4111-8111-111111111111";
const ctx = {
  database: baseStoreNames(id).database,
  prefix: "pulse_",
  rawRetentionDays: 30,
  rollupRetentionDays: 365,
  sensitiveRetentionHours: 24,
};
test("DDL names are derived from UUIDs, validated again and every view has a definer", () => {
  expect(baseStoreNames(id)).toEqual({
    database: "pulse_11111111111141118111111111111111",
    readUser: "pulse_r_11111111111141118111111111111111",
  });
  for (const bad of ["x; DROP DATABASE x", id + "'", "../"]) expect(() => baseStoreNames(bad)).toThrow();
  expect(() => baseStoreNames(id, "pulse_';")).toThrow();
  expect(() => baseTtlStatements({ ...ctx, database: "pulse_rogue" })).toThrow();
  const statements = BASE_SCHEMA_VERSIONS[0]!.statements(ctx),
    views = statements.filter((s) => s.startsWith("CREATE OR REPLACE VIEW"));
  expect(views.length).toBe(6);
  expect(READ_VIEWS).toContain("histogram_quantile");
  for (const view of views) {
    expect(view).toContain("DEFINER = CURRENT_USER SQL SECURITY DEFINER");
    expect(view).not.toMatch(/\b(sensitive|payload)\b/);
  }
  expect(statements.find((s) => s.includes("`_samples`"))).not.toContain("TTL");
  for (const key of ["rawRetentionDays", "rollupRetentionDays", "sensitiveRetentionHours"] as const)
    for (const invalid of [0, 1.2, NaN, Infinity, key === "sensitiveRetentionHours" ? 8761 : 3651])
      expect(() => baseTtlStatements({ ...ctx, [key]: invalid })).toThrow();
});

test("v2 orders states by observation then acceptance and hides source and series tombstones", () => {
  expect(BASE_SCHEMA_VERSIONS.map((v) => v.version)).toEqual([1, 2, 3]);
  const statements = BASE_SCHEMA_VERSIONS[1]!.statements(ctx);
  expect(statements[0]).toContain("ADD COLUMN IF NOT EXISTS deleted UInt8 DEFAULT 0");
  expect(statements[1]).toContain("ReplacingMergeTree(merge_version)");
  expect(statements[1]).toContain("bitShiftLeft");
  expect(statements.find((s) => s.includes(".states "))).toContain("tuple(src.updated_at, src.version)");
  expect(statements.find((s) => s.includes(".sources "))).toContain("WHERE deleted=0");
  expect(statements.find((s) => s.startsWith("ALTER TABLE") && s.includes("._series "))).toContain(
    "ADD COLUMN IF NOT EXISTS deleted UInt8 DEFAULT 0",
  );
  expect(statements.find((s) => s.includes(".series "))).toContain("._series FINAL WHERE deleted=0");
  expect(BASE_SCHEMA_VERSIONS[0]!.statements(ctx).find((s) => s.includes("`_series`"))).toContain("ReplacingMergeTree(version)");
});

test("v3 creates only definer helper views over the same base and grants no internal table", () => {
  const statements = BASE_SCHEMA_VERSIONS[2]!.statements(ctx);
  expect(statements).toHaveLength(3);
  for (const [i, name] of (["increase", "rate", "histogram_quantile"] as const).entries()) {
    expect(READ_VIEWS).toContain(name);
    expect(statements[i]).toStartWith(`CREATE OR REPLACE VIEW \`${ctx.database}\`.${name} DEFINER = CURRENT_USER SQL SECURITY DEFINER AS `);
    expect(statements[i]).not.toMatch(/CREATE FUNCTION|sensitive|payload/);
  }
  expect(statements[0]).toContain("if(value>=previous_value,value-previous_value,value)");
  expect(statements[2]).toContain("Histogram bucket bounds changed at ");
});
