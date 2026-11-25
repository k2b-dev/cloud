import { describe, expect, test } from "bun:test";
import { defineListQuery, field, LIST_QUERY_MAX_LENGTH, type ListQueryStateOf, type LookupItem } from "./list-query";

const noItems = async (): Promise<readonly LookupItem[]> => [];

/** The state `set` returned; fails the test when the URL could not hold it. */
const must = <T>(state: T | undefined): T => {
  if (state === undefined) throw new Error("set returned undefined");
  return state;
};

const articles = defineListQuery({
  key: "articles",
  fields: {
    status: field.choice({
      label: "Status",
      options: [
        { value: "consigned", label: "Consigned" },
        { value: "photographed", label: "Photographed" },
        { value: "sold", label: "Sold" },
      ],
    }),
    location: field.choice({
      label: "Location",
      multiple: false,
      options: [
        { value: "hall", label: "Hall" },
        { value: "store", label: "Store" },
      ],
    }),
    price: field.numberRange({ label: "Price", unit: "€" }),
    consignor: field.lookup({ label: "Consignor", load: async () => ({ items: [] }), resolve: noItems }),
    received: field.dateRange({ label: "Received", presets: [{ value: "last-30d", label: "Last 30 days" }] }),
    twofa: field.bool({ label: "2FA", labels: { yes: "on", no: "off" } }),
    request: field.text({ label: "Request" }),
  },
  search: { label: "Number or title" },
  sort: {
    options: { received: { label: "Received", directions: ["desc", "asc"] }, price: { label: "Price" } },
    default: { field: "received", direction: "desc" },
  },
  group: { status: { label: "Status" }, location: { label: "Location" } },
  pageParams: ["selected"],
});

const logs = defineListQuery({
  key: "logs",
  fields: {
    time: field.timeRange({
      label: "Time",
      presets: [
        { value: "last-15m", label: "Last 15 minutes" },
        { value: "last-1h", label: "Last hour" },
      ],
      required: { kind: "preset", preset: "last-15m" },
    }),
    level: field.choice({ label: "Level", options: [{ value: "error", label: "Error" }] }),
  },
  sort: { fixed: { field: "time", direction: "desc", label: "Newest first" } },
});

type ArticleState = ListQueryStateOf<typeof articles>;

const full: ArticleState = {
  view: "own-7",
  filters: {
    status: ["consigned", "photographed"],
    location: "store",
    price: { min: 500 },
    consignor: ["c-1001", "c-0042"],
    received: { kind: "range", from: "2026-11-01", to: "2026-11-30" },
    twofa: false,
    request: "7f3a9c",
  },
  search: "Kommode",
  sort: { field: "price", direction: "desc" },
  group: "location",
};

describe("list query URL", () => {
  test("a full state round-trips without loss in a stable order", () => {
    const params = articles.serialize(full);
    expect(params.toString()).toBe(
      "view=own-7&status=consigned,photographed&location=store&price=500..&consignor=c-1001,c-0042" +
        "&received=2026-11-01..2026-11-30&twofa=no&request=7f3a9c&q=Kommode&sort=price.desc&group=location",
    );
    const parsed = articles.parse(params);
    expect(parsed.issues).toEqual([]);
    expect(parsed.state).toEqual(full);
    expect(articles.serialize(parsed.state).toString()).toBe(params.toString());
  });

  test("commas, colons, slashes and @ stay readable; everything else stays encoded and round-trips", () => {
    const state = must(articles.set(articles.reset(), "consignor", ["a@b.example", "x/y", "t:1"]));
    expect(articles.serialize(state).toString()).toBe("consignor=a@b.example,x/y,t:1");
    expect(articles.parse(articles.serialize(state).toString()).state).toEqual(state);

    // A value that must stay encoded: a literal "%2C", form characters, a hash, a space and non-ASCII text.
    const tricky = "%2C & = + # ? ; ä";
    const searched = must(articles.set(articles.reset(), "q", tricky));
    const text = articles.serialize(searched).toString();
    expect(text).toBe("q=%252C+%26+%3D+%2B+%23+%3F+%3B+%C3%A4");
    expect(articles.parse(text)).toEqual({ state: searched, issues: [] });
    expect(articles.parse(new URL(`https://example.test/articles?${text}`).searchParams).state).toEqual(searched);

    // Page parameters from base read the same way; the result stays URLSearchParams.
    const params = articles.serialize(state, "selected=a,b");
    expect(params).toBeInstanceOf(URLSearchParams);
    expect(`${params}`).toBe("selected=a,b&consignor=a@b.example,x/y,t:1");
    expect(params.get("selected")).toBe("a,b");
    const url = new URL("https://example.test/articles");
    url.search = params.toString();
    expect(url.search).toBe("?selected=a,b&consignor=a@b.example,x/y,t:1");
  });

  test("the URL order follows the declaration, not the input", () => {
    const parsed = articles.parse("group=status&q=x&price=..20&status=sold&view=all");
    expect(articles.serialize(parsed.state).toString()).toBe("view=all&status=sold&price=..20&q=x&group=status");
  });

  test("defaults are omitted, and the default state is an empty URL", () => {
    expect(articles.serialize(articles.reset()).toString()).toBe("");
    expect(articles.parse("sort=received.desc").state).toEqual(articles.reset());
    expect(articles.serialize(articles.parse("sort=received.desc").state).toString()).toBe("");
  });

  test("an empty URL parses to the defaults without issues", () => {
    expect(articles.parse("")).toEqual({
      state: { filters: {}, sort: { field: "received", direction: "desc" } },
      issues: [],
    });
  });

  test("multiple values follow the declared order, lookups keep the chosen order, and duplicates collapse", () => {
    const parsed = articles.parse("status=sold,consigned,sold&consignor=c-2,c-1,c-2");
    expect(parsed.state.filters.status).toEqual(["consigned", "sold"]);
    expect(parsed.state.filters.consignor).toEqual(["c-2", "c-1"]);
    expect(parsed.issues).toEqual([]);
  });

  test("invalid values among valid ones are dropped one by one", () => {
    const parsed = articles.parse("status=sold,gone,consigned");
    expect(parsed.state.filters.status).toEqual(["consigned", "sold"]);
    expect(parsed.issues).toEqual([{ code: "invalid", param: "status", value: "gone" }]);
  });

  test("a single choice accepts exactly one declared value", () => {
    expect(articles.parse("location=hall").state.filters.location).toBe("hall");
    expect(articles.parse("location=hall,store")).toMatchObject({
      state: { filters: {} },
      issues: [{ code: "invalid", param: "location", value: "hall,store" }],
    });
    expect(articles.parse("location=cellar").issues).toEqual([{ code: "invalid", param: "location", value: "cellar" }]);
  });

  test("number ranges allow open ends and reject reversed, empty or malformed ones", () => {
    expect(articles.parse("price=500..2000").state.filters.price).toEqual({ min: 500, max: 2000 });
    expect(articles.parse("price=500..").state.filters.price).toEqual({ min: 500 });
    expect(articles.parse("price=..2000").state.filters.price).toEqual({ max: 2000 });
    expect(articles.parse("price=-5.5..0").state.filters.price).toEqual({ min: -5.5, max: 0 });
    for (const raw of ["2000..500", "..", "500", "a..b", "1..2..3", "01..2", "1e3.."]) {
      const parsed = articles.parse(new URLSearchParams({ price: raw }));
      expect(parsed.state.filters.price).toBeUndefined();
      expect(parsed.issues).toEqual([{ code: "invalid", param: "price", value: raw }]);
    }
  });

  test("date ranges take presets or real calendar days with open ends", () => {
    expect(articles.parse("received=last-30d").state.filters.received).toEqual({ kind: "preset", preset: "last-30d" });
    expect(articles.parse("received=2026-11-01..").state.filters.received).toEqual({ kind: "range", from: "2026-11-01" });
    expect(articles.parse("received=..2026-11-30").state.filters.received).toEqual({ kind: "range", to: "2026-11-30" });
    expect(articles.parse("received=2026-11-24..2026-11-24").state.filters.received).toEqual({
      kind: "range",
      from: "2026-11-24",
      to: "2026-11-24",
    });
    for (const raw of ["last-7d", "2026-02-30..", "2026-11-30..2026-11-01", "..", "2026-11-01T10:00Z.."]) {
      expect(articles.parse(new URLSearchParams({ received: raw })).issues).toEqual([{ code: "invalid", param: "received", value: raw }]);
    }
  });

  test("a mandatory time range falls back to its default, is omitted at the default, and keeps custom ranges", () => {
    expect(logs.parse("").state.filters.time).toEqual({ kind: "preset", preset: "last-15m" });
    expect(logs.serialize(logs.reset()).toString()).toBe("");
    expect(logs.parse("time=last-15m").state).toEqual(logs.reset());

    const hour = logs.parse("time=last-1h");
    expect(hour.state.filters.time).toEqual({ kind: "preset", preset: "last-1h" });
    expect(logs.serialize(hour.state).toString()).toBe("time=last-1h");

    const custom = logs.parse("time=2026-11-24T08:00Z..2026-11-24T09:30Z");
    expect(custom.state.filters.time).toEqual({ kind: "range", from: "2026-11-24T08:00Z", to: "2026-11-24T09:30Z" });
    expect(logs.serialize(custom.state).toString()).toBe("time=2026-11-24T08:00Z..2026-11-24T09:30Z");

    for (const raw of ["2026-11-24T24:00Z..", "2026-11-24..", "last-2h"]) {
      const parsed = logs.parse(new URLSearchParams({ time: raw }));
      expect(parsed.state.filters.time).toEqual({ kind: "preset", preset: "last-15m" });
      expect(parsed.issues).toEqual([{ code: "invalid", param: "time", value: raw }]);
    }
  });

  test("a time range without custom ranges accepts only presets", () => {
    const onlyPresets = defineListQuery({
      key: "presets",
      fields: { time: field.timeRange({ label: "Time", presets: [{ value: "today", label: "Today" }], custom: false }) },
      sort: { fixed: { field: "time", direction: "desc", label: "Newest first" } },
    });
    expect(onlyPresets.parse("time=today").state.filters.time).toEqual({ kind: "preset", preset: "today" });
    expect(onlyPresets.parse("time=2026-11-24T08:00Z..").issues).toEqual([
      { code: "invalid", param: "time", value: "2026-11-24T08:00Z.." },
    ]);
  });

  test("booleans are yes or no", () => {
    expect(articles.parse("twofa=yes").state.filters.twofa).toBe(true);
    expect(articles.parse("twofa=no").state.filters.twofa).toBe(false);
    expect(articles.parse("twofa=true").issues).toEqual([{ code: "invalid", param: "twofa", value: "true" }]);
  });

  test("unknown, duplicate and invalid sort or group parameters are reported and dropped", () => {
    const parsed = articles.parse("color=red&status=sold&status=consigned&sort=title.asc&group=era&view=a%20b");
    expect(parsed.state).toEqual({ filters: { status: ["sold"] }, sort: { field: "received", direction: "desc" } });
    expect(parsed.issues).toEqual([
      { code: "unknown", param: "color", value: "red" },
      { code: "duplicate", param: "status", value: "consigned" },
      { code: "invalid", param: "sort", value: "title.asc" },
      { code: "invalid", param: "group", value: "era" },
      { code: "invalid", param: "view", value: "a b" },
    ]);
  });

  test("a sort direction the option does not offer is invalid", () => {
    const only = defineListQuery({
      key: "only",
      fields: {},
      sort: { options: { name: { label: "Name", directions: ["asc"] } }, default: { field: "name", direction: "asc" } },
    });
    expect(only.parse("sort=name.desc").issues).toEqual([{ code: "invalid", param: "sort", value: "name.desc" }]);
  });

  test("a fixed sort has no URL parameter", () => {
    const parsed = logs.parse("sort=time.asc");
    expect(parsed.state.sort).toEqual({ field: "time", direction: "desc" });
    expect(parsed.issues).toEqual([{ code: "invalid", param: "sort", value: "time.asc" }]);
  });

  test("search needs a declaration; without one `q` is unknown", () => {
    expect(articles.parse("q=Kommode").state.search).toBe("Kommode");
    expect(logs.parse("q=x").issues).toEqual([{ code: "unknown", param: "q", value: "x" }]);
  });

  test("page parameters and underscore parameters are ignored and kept by serialize", () => {
    const parsed = articles.parse("selected=42&_open=status&status=sold");
    expect(parsed.issues).toEqual([]);
    expect(articles.serialize(parsed.state, "selected=42&_open=status&status=consigned&q=old").toString()).toBe(
      "selected=42&_open=status&status=sold",
    );
  });

  test("empty values are inactive filters without issues", () => {
    expect(articles.parse("status=&q=&price=")).toEqual({ state: articles.reset(), issues: [] });
  });

  test("a query over the length limit is dropped as a whole", () => {
    const long = articles.parse(new URLSearchParams({ q: "x".repeat(LIST_QUERY_MAX_LENGTH), status: "sold" }));
    expect(long.state).toEqual(articles.reset());
    expect(long.issues).toMatchObject([{ code: "too_long" }]);
    // Page parameters do not count.
    expect(articles.parse(new URLSearchParams({ selected: "x".repeat(LIST_QUERY_MAX_LENGTH) })).issues).toEqual([]);
  });
});

describe("list query helpers", () => {
  test("set and clear change one statement and keep the rest", () => {
    const start = articles.parse("view=all&status=sold&q=x").state;
    const withPrice = must(articles.set(start, "price", { min: 10 }));
    expect(withPrice).toEqual({
      view: "all",
      filters: { status: ["sold"], price: { min: 10 } },
      search: "x",
      sort: { field: "received", direction: "desc" },
    });
    expect(articles.clear(withPrice, "status")).toEqual({
      view: "all",
      filters: { price: { min: 10 } },
      search: "x",
      sort: { field: "received", direction: "desc" },
    });
    expect(start.filters).toEqual({ status: ["sold"] });
  });

  test("setting an empty value clears the statement", () => {
    const start = articles.parse("status=sold&price=1..").state;
    expect(must(articles.set(start, "status", [])).filters).toEqual({ price: { min: 1 } });
    expect(must(articles.set(start, "price", {})).filters).toEqual({ status: ["sold"] });
  });

  test("a mandatory field returns to its default when cleared or emptied", () => {
    const hour = logs.parse("time=last-1h&level=error").state;
    expect(logs.clear(hour, "time").filters).toEqual({ time: { kind: "preset", preset: "last-15m" }, level: ["error"] });
    expect(must(logs.set(hour, "time", { kind: "range" })).filters.time).toEqual({ kind: "preset", preset: "last-15m" });
  });

  test("set changes the search, sort and grouping too, and empties remove them", () => {
    const start = articles.parse("q=x&group=status").state;
    const sorted = must(articles.set(start, "sort", { field: "price", direction: "asc" }));
    expect(articles.serialize(sorted).toString()).toBe("q=x&sort=price.asc&group=status");
    expect(must(articles.set(sorted, "q", "")).search).toBeUndefined();
    expect(must(articles.set(sorted, "q", "Kommode")).search).toBe("Kommode");
    expect(must(articles.set(sorted, "group", undefined)).group).toBeUndefined();
    expect(must(articles.set(sorted, "group", "location")).group).toBe("location");
  });

  test("a follow-up state of a URL at the limit is undefined, never a throw (the documented link flow)", () => {
    // parse accepts exactly LIST_QUERY_MAX_LENGTH characters; one more filter does not fit.
    const url = new URL(`https://example.test/articles?q=${"x".repeat(LIST_QUERY_MAX_LENGTH - 2)}`);
    const { state, issues } = articles.parse(url.searchParams);
    expect(issues).toEqual([]);
    expect(state.search?.length).toBe(LIST_QUERY_MAX_LENGTH - 2);
    const next = articles.set(state, "price", { min: 500 });
    expect(next).toBeUndefined();
    const href = next && `?${articles.serialize(next)}`;
    expect(href).toBeUndefined();
    // Clearing and resetting always fit.
    expect(() => articles.serialize(articles.clear(state, "price"))).not.toThrow();
    expect(articles.serialize(articles.reset()).toString()).toBe("");
  });

  test("reset returns the defaults", () => {
    expect(logs.reset()).toEqual({ filters: { time: { kind: "preset", preset: "last-15m" } }, sort: { field: "time", direction: "desc" } });
  });
});

describe("list query review guards", () => {
  test("the sort whitelist reads only declared options, never inherited keys", () => {
    for (const raw of ["__proto__.asc", "constructor.asc", "toString.desc", "hasOwnProperty.asc"]) {
      const parsed = articles.parse(new URLSearchParams({ sort: raw }));
      expect(parsed.state.sort).toEqual({ field: "received", direction: "desc" });
      expect(parsed.issues).toEqual([{ code: "invalid", param: "sort", value: raw }]);
    }
    for (const raw of ["constructor", "toString", "__proto__"]) {
      expect(articles.parse(new URLSearchParams({ group: raw })).issues).toEqual([{ code: "invalid", param: "group", value: raw }]);
    }
    expect(() =>
      defineListQuery({
        key: "x",
        fields: {},
        sort: { options: { name: { label: "Name" } }, default: { field: "constructor" as "name", direction: "asc" } },
      }),
    ).toThrow("default sort");
    expect(() => articles.serialize({ ...articles.reset(), sort: { field: "constructor" as "price", direction: "asc" } })).toThrow(
      RangeError,
    );
  });

  test("field keys of Object.prototype are refused, so no filter reads an inherited value", () => {
    const sort = { fixed: { field: "id", direction: "asc", label: "ID" } } as const;
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect(() => defineListQuery({ key: "x", fields: { [key]: field.text({ label: "X" }) }, sort })).toThrow("field key");
    }
  });

  test("numbers outside the one URL grammar are invalid in parse, refused by set and thrown by serialize", () => {
    const tooLarge = "9".repeat(309);
    for (const raw of ["0.0000001..", "1000000000000000000000..", `${tooLarge}..`, "1e3..", "+5.."]) {
      const parsed = articles.parse(new URLSearchParams({ price: raw }));
      expect(parsed.state.filters.price).toBeUndefined();
      expect(parsed.issues).toEqual([{ code: "invalid", param: "price", value: raw }]);
    }
    const start = articles.reset();
    for (const range of [{ min: 0.0000001 }, { min: 1e21 }, { max: Number.POSITIVE_INFINITY }, { min: Number.NaN }, { min: 5, max: 1 }]) {
      expect(articles.set(start, "price", range)).toBeUndefined();
      expect(() => articles.serialize({ ...start, filters: { price: range } })).toThrow(RangeError);
    }
    // What the grammar holds round-trips exactly, including the canonical form of zero.
    const small = must(articles.set(start, "price", { min: 0.000001, max: 123456789012345 }));
    expect(articles.parse(articles.serialize(small)).state).toEqual(small);
    expect(articles.serialize(must(articles.set(start, "price", { min: -0 }))).toString()).toBe("price=0..");
  });

  test("a mandatory value is checked as a whole and stored in its canonical form", () => {
    const sort = { fixed: { field: "id", direction: "asc", label: "ID" } } as const;
    const options = [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ];
    expect(() =>
      defineListQuery({
        key: "x",
        fields: { tag: field.choice({ label: "Tag", options, required: ["a", "unknown" as "a"] }) },
        sort,
      }),
    ).toThrow("required value");
    const ordered = defineListQuery({
      key: "x",
      fields: { tag: field.choice({ label: "Tag", options, required: ["b", "a", "b"] }) },
      sort,
    });
    expect(ordered.reset().filters.tag).toEqual(["a", "b"]);
    expect(ordered.parse("").state.filters.tag).toEqual(["a", "b"]);
    expect(ordered.clear(ordered.parse("tag=a").state, "tag").filters.tag).toEqual(["a", "b"]);
    expect(ordered.serialize(ordered.reset()).toString()).toBe("");
  });

  test("values the URL cannot hold are refused instead of changing on the way", () => {
    const start = articles.reset();
    expect(articles.set(start, "consignor", ["a,b"])).toBeUndefined();
    expect(articles.set(start, "status", ["consigned", "gone" as "sold"])).toBeUndefined();
    expect(articles.set(start, "received", { kind: "range", from: "2026-11-30", to: "2026-11-01" })).toBeUndefined();
    expect(articles.set(start, "received", { kind: "preset", preset: "last-7d" as "last-30d" })).toBeUndefined();
    expect(articles.set(start, "sort", { field: "constructor" as "price", direction: "asc" })).toBeUndefined();
    expect(articles.set(start, "group", "era" as "status")).toBeUndefined();
    expect(logs.set(logs.reset(), "q", "x")).toBeUndefined();
    expect(logs.set(logs.reset(), "sort", { field: "time", direction: "asc" })).toBeUndefined();
  });

  test("serialize and set never produce a query that parse rejects as too long", () => {
    const fits = "x".repeat(LIST_QUERY_MAX_LENGTH - "request=".length);
    const atLimit = must(articles.set(articles.reset(), "request", fits));
    const params = articles.serialize(atLimit);
    expect(params.toString().length).toBe(LIST_QUERY_MAX_LENGTH);
    expect(articles.parse(params)).toEqual({ state: atLimit, issues: [] });

    expect(articles.set(articles.reset(), "request", `${fits}x`)).toBeUndefined();
    expect(articles.set(atLimit, "twofa", true)).toBeUndefined();
    expect(articles.set(atLimit, "sort", { field: "price", direction: "asc" })).toBeUndefined();
    expect(articles.set(atLimit, "group", "status")).toBeUndefined();
    expect(() => articles.serialize({ ...articles.reset(), filters: { request: `${fits}x` } })).toThrow(RangeError);
    // Page parameters do not count.
    expect(articles.serialize(atLimit, new URLSearchParams({ selected: "y".repeat(500) })).get("request")).toBe(fits);
  });

  test("calendar days include the years 0000 to 0099", () => {
    for (const day of ["0000-01-01", "0001-02-28", "0099-12-31"]) {
      const parsed = articles.parse(new URLSearchParams({ received: `${day}..` }));
      expect(parsed.issues).toEqual([]);
      expect(parsed.state.filters.received).toEqual({ kind: "range", from: day });
    }
    expect(articles.parse("received=0099-02-29..").issues).toEqual([{ code: "invalid", param: "received", value: "0099-02-29.." }]);
    expect(articles.parse("received=0096-02-29..").issues).toEqual([]);
  });
});

test("the module imports nothing, so server routes load it without Solid or a DOM", async () => {
  const source = await Bun.file(new URL("./list-query.ts", import.meta.url)).text();
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  expect(code).not.toMatch(/^\s*(?:import|export)\b[^;]*\bfrom\s*["']/m);
  expect(code).not.toMatch(/\bimport\s*\(/);
});

describe("list query declaration", () => {
  const sort = { fixed: { field: "id", direction: "asc", label: "ID" } } as const;

  test("reserved, underscore and malformed field keys are refused", () => {
    for (const key of ["q", "view", "sort", "group", "_open", "a b", "1st"]) {
      expect(() => defineListQuery({ key: "x", fields: { [key]: field.text({ label: "X" }) }, sort })).toThrow("field key");
    }
  });

  test("values with commas and presets with two dots are refused", () => {
    expect(() =>
      defineListQuery({ key: "x", fields: { tag: field.choice({ label: "Tag", options: [{ value: "a,b", label: "A" }] }) }, sort }),
    ).toThrow("comma");
    expect(() =>
      defineListQuery({ key: "x", fields: { day: field.dateRange({ label: "Day", presets: [{ value: "a..b", label: "A" }] }) }, sort }),
    ).toThrow('".."');
  });

  test("a mandatory value that does not parse is refused", () => {
    expect(() =>
      defineListQuery({ key: "x", fields: { price: field.numberRange({ label: "Price", required: { min: 5, max: 1 } }) }, sort }),
    ).toThrow("required value");
  });

  test("a lookup limit above 50 is refused", () => {
    expect(() =>
      defineListQuery({
        key: "x",
        fields: { who: field.lookup({ label: "Who", load: async () => ({ items: [] }), resolve: noItems, limit: 51 }) },
        sort,
      }),
    ).toThrow("limit");
  });

  test("a page parameter that is also a field or reserved is refused", () => {
    expect(() => defineListQuery({ key: "x", fields: { id: field.text({ label: "ID" }) }, sort, pageParams: ["id"] })).toThrow("both");
    expect(() => defineListQuery({ key: "x", fields: {}, sort, pageParams: ["q"] })).toThrow("reserved");
  });
});
