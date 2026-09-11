import { sql } from "bun";

/** Ignore insignificant display zeroes, matching the formula runtime's decimal values. */
export const numericDivideSql = (left: unknown, right: unknown) =>
  sql`(trim_scale((${left})::numeric) / NULLIF(trim_scale((${right})::numeric), 0))`;

export const numericAverageSql = (value: unknown) => numericDivideSql(sql`SUM((${value})::numeric)`, sql`COUNT(${value})`);
