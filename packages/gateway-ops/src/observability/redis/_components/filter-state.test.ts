import { describe, expect, test } from "bun:test";
import { buildRedisFilterUrl, defaultRedisFilter, hasActiveRedisFilters, parseRedisFilterFromUrl, type RedisFilter } from "./filter-state";

const parse = (path: string) => parseRedisFilterFromUrl(new URL(path, "https://cloud.test"));

describe("Redis filter URLs", () => {
  const filter: RedisFilter = { search: "cloud:mail & jobs", depth: 2 };

  test("round-trips and preserves search when changing depth", () => {
    expect(parse(buildRedisFilterUrl(filter))).toEqual(filter);
    expect(parse(buildRedisFilterUrl(filter, { depth: 1 }))).toEqual({ ...filter, depth: 1 });
    expect(parse(buildRedisFilterUrl(filter, { search: "cloud:core" }))).toEqual({ ...filter, search: "cloud:core" });
    expect(parse(buildRedisFilterUrl(filter, { search: "" }))).toEqual({ ...filter, search: "" });
  });

  test.each(["invalid", "NaN", "Infinity", "2.5", "0", "4", "-1"])("defaults unsupported depth %s", (depth) => {
    expect(parse(`/?depth=${depth}`).depth).toBe(3);
  });

  test("clear removes search and resets depth", () => {
    expect(hasActiveRedisFilters(filter)).toBe(true);
    expect(hasActiveRedisFilters({ ...defaultRedisFilter, search: "cloud:" })).toBe(true);
    expect(hasActiveRedisFilters({ ...defaultRedisFilter, depth: 1 })).toBe(true);
    const clear = buildRedisFilterUrl(defaultRedisFilter);
    expect(clear).toBe("/admin/observability/redis");
    expect(parse(clear)).toEqual(defaultRedisFilter);
    expect(hasActiveRedisFilters(parse(clear))).toBe(false);
  });
});
