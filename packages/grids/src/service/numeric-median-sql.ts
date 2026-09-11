import { sql } from "bun";
import { numericDivideSql } from "./numeric-division-sql";

/** PostgreSQL percentile_cont coerces numeric to float8. Keep both middle values numeric. */
export const numericMedianSql = (value: unknown) => {
  // Opposite orderings select the lower and upper middle values (the same
  // value for odd counts). Native ordered-set sorting can spill to disk; do
  // not collect an unbounded group into a PostgreSQL array.
  const lower = sql`PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY (${value})::numeric ASC)`;
  const upper = sql`PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY (${value})::numeric DESC)`;
  return numericDivideSql(sql`(${lower} + ${upper})`, sql`2::numeric`);
};
