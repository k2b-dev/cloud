import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LOG_TIME,
  endsNow,
  LOG_VIEWS,
  legacyLogsHref,
  logSearchOf,
  logsApiParams,
  logsHref,
  logsQuery,
  logsWindow,
  parseLogsAddress,
} from "./query";

// Every date in this file is fixed: the address names absolute minutes and presets count back from `now`.
const now = new Date("2026-11-25T10:43:30.000Z");
const query = logsQuery("de");
const read = (search: string) => parseLogsAddress(query, new URLSearchParams(search), now);

describe("the log list address", () => {
  test("an empty address is the last 24 hours, newest first, without groups, live on", () => {
    const address = read("");
    expect(address.state.filters.time).toEqual(DEFAULT_LOG_TIME);
    expect(address.state.sort).toEqual({ field: "time", direction: "desc" });
    expect(address).toMatchObject({ page: 1, entry: null, liveOff: false, issues: [] });
    expect(endsNow(address.state)).toBe(true);
  });

  test("filters, search, group and page parameters read back into the same address", () => {
    const search = "time=last-15m&level=warn,error&source=mail,gateway&request=7f3a9c&q=Zeit%C3%BCberschreitung&group=minute";
    const address = read(`${search}&page=2&entry=9001&live=off`);
    expect(address.issues).toEqual([]);
    expect(address.state.filters).toEqual({
      time: { kind: "preset", preset: "last-15m" },
      level: ["warn", "error"],
      source: ["mail", "gateway"],
      request: "7f3a9c",
    });
    expect(address).toMatchObject({ page: 2, entry: "9001", liveOff: true });
    // k2b-ui gap: 6 – serialize writes commas as %2C; the concept shows plain commas.
    expect(logsHref(query, address.state, { page: 2, entry: "9001", liveOff: true })).toBe(
      `/admin/observability/logs?${search.replaceAll(",", "%2C")}&page=2&entry=9001&live=off`,
    );
  });

  test("values beyond the list's bounds are dropped and reported, never cut", () => {
    const sources = Array.from({ length: 21 }, (_, index) => `app-${index}`).join(",");
    const address = read(
      `q=${"x".repeat(201)}&request=${"r".repeat(129)}&source=${sources}&time=2026-10-01T00:00Z..2026-11-25T00:00Z&page=1001&entry=0`,
    );
    expect(address.state.search).toBeUndefined();
    expect(address.state.filters).toEqual({ time: DEFAULT_LOG_TIME });
    expect(address.issues.map((issue) => issue.param)).toEqual(["q", "request", "source", "time"]);
    expect(address).toMatchObject({ page: 1, entry: null });
  });

  test("unknown parameters and values are reported, the rest applies", () => {
    const address = read("level=error,fatal&colour=red");
    expect(address.state.filters.level).toEqual(["error"]);
    expect(address.issues).toEqual([
      { code: "unknown", param: "colour", value: "red" },
      { code: "invalid", param: "level", value: "fatal" },
    ]);
  });

  test("a preset counts back from now; a custom range counts its end minute whole", () => {
    expect(logsWindow({ kind: "preset", preset: "last-15m" }, now)).toEqual({ since: new Date("2026-11-25T10:28:30.000Z") });
    expect(logsWindow({ kind: "range", from: "2026-11-24T08:00Z", to: "2026-11-24T09:30Z" }, now)).toEqual({
      since: new Date("2026-11-24T08:00:00.000Z"),
      until: new Date("2026-11-24T09:31:00.000Z"),
    });
    const past = read("time=2026-11-24T08:00Z..2026-11-24T09:30Z").state;
    expect(endsNow(past)).toBe(false);
  });

  test("the service receives exactly the filters of the state", () => {
    const { state } = read("time=last-1h&level=error&source=mail&request=7f3a9c&q=SMTP");
    expect(logSearchOf(state, now)).toEqual({
      since: new Date("2026-11-25T09:43:30.000Z"),
      levels: ["error"],
      sources: ["mail"],
      search: "SMTP",
      request: "7f3a9c",
    });
  });

  test("the errors view in code is the level filter plus its key", () => {
    expect(logsHref(query, LOG_VIEWS.errors(query))).toBe("/admin/observability/logs?view=errors&level=error");
  });
});

describe("addresses from before v2", () => {
  test("lead to the same list in the v2 address", () => {
    const legacy = (search: string) => legacyLogsHref(new URLSearchParams(search));
    expect(legacy("source=auth:ipa:sync&window=7d")).toBe("/admin/observability/logs?time=last-7d&source=auth%3Aipa%3Async");
    expect(legacy("search=grids")).toBe("/admin/observability/logs?q=grids");
    expect(legacy("window=1h")).toBe("/admin/observability/logs?time=last-1h");
    expect(legacy("window=24h&level=all&page=3")).toBe("/admin/observability/logs?page=3");
    expect(legacy("source=a&source=b&entry=12")).toBe("/admin/observability/logs?source=a%2Cb&entry=12");
  });

  test("v2 addresses and the old single-value links need no redirect", () => {
    for (const search of ["", "level=error", "level=warn", "source=ipa-hosts:sync", "entry=9000", "time=last-15m&q=x"]) {
      expect(legacyLogsHref(new URLSearchParams(search))).toBeNull();
    }
  });

  test("the API keeps `search` and `since_hours` beside the v2 names", () => {
    const params = logsApiParams(new URLSearchParams("search=grids&since_hours=6&per_page=50&page=2"), now);
    expect(params.toString()).toBe("page=2&q=grids&time=2026-11-25T04%3A43Z..");
    const address = parseLogsAddress(query, params, now);
    expect(address.issues).toEqual([]);
    expect(logSearchOf(address.state, now)).toMatchObject({ since: new Date("2026-11-25T04:43:00.000Z"), search: "grids" });
    expect(parseLogsAddress(query, logsApiParams(new URLSearchParams("since_hours=744"), now), now).issues).toEqual([]);
  });
});
