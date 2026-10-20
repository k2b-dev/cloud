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
  expect(views.length).toBe(READ_VIEWS.length);
  for (const view of views) {
    expect(view).toContain("DEFINER = CURRENT_USER SQL SECURITY DEFINER");
    expect(view).not.toMatch(/\b(sensitive|payload)\b/);
  }
  expect(statements.find((s) => s.includes("`_samples`"))).not.toContain("TTL");
  for (const key of ["rawRetentionDays", "rollupRetentionDays", "sensitiveRetentionHours"] as const)
    for (const invalid of [0, 1.2, NaN, Infinity, key === "sensitiveRetentionHours" ? 8761 : 3651])
      expect(() => baseTtlStatements({ ...ctx, [key]: invalid })).toThrow();
});
