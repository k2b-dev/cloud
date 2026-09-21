import { describe, expect, test } from "bun:test";
import { buildLogFilterUrl, defaultLogFilter, type LogFilterState, parseLogFilterFromUrl } from "./types";

const baseUrl = "/admin/observability/logs";
const parse = (path: string) => parseLogFilterFromUrl(new URL(path, "https://cloud.test"));

describe("log filter URLs", () => {
  test("round-trips multiple sources, search, window, and pagination", () => {
    const filter: LogFilterState = {
      level: "error",
      sources: ["mail.worker", "core & gateway"],
      search: "failed & retry",
      window: "7d",
      page: 3,
    };
    expect(parse(buildLogFilterUrl(baseUrl, {}, filter))).toEqual(filter);
    expect(parse(buildLogFilterUrl(baseUrl, { level: "warn", page: 1 }, filter))).toEqual({ ...filter, level: "warn", page: 1 });
  });

  test("normalizes native GET search input", () => {
    expect(parse(`${baseUrl}?search=++failed++`).search).toBe("failed");
    expect(parse(`${baseUrl}?search=+++`).search).toBe("");
  });

  test("deduplicates sources without losing their order", () => {
    expect(parse(`${baseUrl}?source=mail&source=+core+&source=mail&source=`).sources).toEqual(["mail", "core"]);
  });

  test.each(["constructor", "toString", "__proto__", "unknown"])("rejects invalid window %s", (window) => {
    expect(parse(`${baseUrl}?window=${window}`).window).toBe(defaultLogFilter.window);
  });

  test.each(["-2", "0", "1.5", "Infinity", "NaN", "2junk", "9007199254740992"])("rejects invalid page %s", (page) => {
    expect(parse(`${baseUrl}?page=${page}`).page).toBe(1);
  });

  test("clearing uses the complete default filter", () => {
    expect(buildLogFilterUrl(baseUrl, {}, defaultLogFilter)).toBe(baseUrl);
    expect(parse(baseUrl)).toEqual(defaultLogFilter);
  });
});
