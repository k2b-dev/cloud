import { expect, test } from "bun:test";
import { bucketTableUnavailable } from "./rows";

// Apps and the gateway with separate database roles may lack the grant; they must fall back like a missing table.
test("a missing table, schema or read grant counts as no further buckets; other database errors do not", () => {
  for (const code of ["42P01", "3F000", "42501"]) {
    expect(bucketTableUnavailable({ code })).toBe(true);
    expect(bucketTableUnavailable({ errno: code })).toBe(true);
  }
  expect(bucketTableUnavailable({ errno: "08006" })).toBe(false);
  expect(bucketTableUnavailable(new Error("connection reset"))).toBe(false);
  expect(bucketTableUnavailable(null)).toBe(false);
});
