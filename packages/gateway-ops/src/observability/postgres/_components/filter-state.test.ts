import { describe, expect, test } from "bun:test";
import {
  buildPostgresFilterUrl,
  defaultPostgresFilter,
  hasActivePostgresFilters,
  type PostgresFilter,
  parsePostgresFilterFromUrl,
} from "./filter-state";

const parse = (path: string) => parsePostgresFilterFromUrl(new URL(path, "https://cloud.test"));

describe("Postgres filter URLs", () => {
  const filter: PostgresFilter = { search: "accounts & audit", schema: "core", sort: "dead-desc" };

  test("round-trips and preserves independent filters when changing search, schema, or sort", () => {
    expect(parse(buildPostgresFilterUrl(filter))).toEqual(filter);
    expect(parse(buildPostgresFilterUrl(filter, { search: "users" }))).toEqual({ ...filter, search: "users" });
    expect(parse(buildPostgresFilterUrl(filter, { schema: "mail" }))).toEqual({ ...filter, schema: "mail" });
    expect(parse(buildPostgresFilterUrl(filter, { sort: "name-asc" }))).toEqual({ ...filter, sort: "name-asc" });
    expect(parse(buildPostgresFilterUrl(filter, { search: "" }))).toEqual({ ...filter, search: "" });
  });

  test("normalizes unknown sort and blank values to defaults", () => {
    expect(parse("/?search=+++&schema=+++&sort=constructor")).toEqual(defaultPostgresFilter);
    expect(parse("/?sort=+rows-desc+").sort).toBe("rows-desc");
  });

  test("clear removes every active filter", () => {
    expect(hasActivePostgresFilters(filter)).toBe(true);
    expect(hasActivePostgresFilters({ ...defaultPostgresFilter, search: "users" })).toBe(true);
    expect(hasActivePostgresFilters({ ...defaultPostgresFilter, schema: "core" })).toBe(true);
    expect(hasActivePostgresFilters({ ...defaultPostgresFilter, sort: "rows-desc" })).toBe(true);
    const clear = buildPostgresFilterUrl(defaultPostgresFilter);
    expect(clear).toBe("/admin/observability/postgres");
    expect(parse(clear)).toEqual(defaultPostgresFilter);
    expect(hasActivePostgresFilters(parse(clear))).toBe(false);
  });
});
