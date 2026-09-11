import { expect } from "bun:test";
import { sql } from "bun";
import { postgresTest } from "../integration-test-utils";
import { numericMedianSql } from "./numeric-median-sql";

postgresTest("numeric median preserves exact values, odd/even counts, duplicates and null semantics", async () => {
  const cases: Array<{ values: Array<string | null>; expected: string | null }> = [
    { values: [], expected: null },
    { values: [null, null], expected: null },
    { values: ["1"], expected: "1" },
    { values: ["3", null, "1"], expected: "2" },
    { values: ["9", "1", "3"], expected: "3" },
    { values: ["1", "1", "1", "9"], expected: "1" },
    { values: ["-3", "-1"], expected: "-2" },
    { values: ["-3", "3"], expected: "0" },
    { values: ["9007199254740993.25", "9007199254740993.35"], expected: "9007199254740993.3" },
  ];
  for (const { values, expected } of cases) {
    const [row] = await sql<Array<{ median: string | null }>>`
      SELECT trim_scale(${numericMedianSql(sql`v::numeric`)})::text AS median
      FROM jsonb_array_elements_text(${{ rows: values }}::jsonb->'rows') input(v)`;
    expect(row?.median).toBe(expected);
  }
});
