import { expect, test } from "bun:test";
import {
  DEFAULT_GRAPH_DISPLAY,
  GRAPH_QUERY_MAX,
  type GraphViewState,
  normalizeGraphViewState,
  PHONE_GRAPH_DISPLAY,
  PHONE_GRAPH_QUERY,
  parseGraphViewState,
  resolveGraphDisplay,
  writeGraphViewState,
} from "./view-state";

const defaults: GraphViewState = { display: null, sort: null, depth: 2, list: false, links: "all", hide: [], q: "" };
const parse = (query: string) => parseGraphViewState(new URLSearchParams(query));
test("empty and invalid view state falls back to defaults", () => {
  expect(parse("")).toEqual(defaults);
  expect(parse("display=local&list=true&links=nope&hide=bad,toolong,!,12345&extra=1")).toEqual(defaults);
  expect(parse("display=network")).toEqual({ ...defaults, display: "network" });
  expect(parse("view=favorites&display=network&list=1&links=linked")).toEqual({
    ...defaults,
    display: "network",
    list: true,
    links: "linked",
  });
});
test("normalized states round trip without changing the URL or other params", () => {
  const url = new URL(
    "https://cloud.example/app/notebooks/book01?mode=graph&note=abc123&from=book&back=%2Fx&view=favorites&tag=x&folder=abc123#graph",
  );
  const original = url.href;
  for (const state of [
    defaults,
    { ...defaults, display: "circle", links: "linked", hide: ["top"], q: "Circle" } satisfies GraphViewState,
    {
      display: "network",
      sort: "changed",
      depth: 1,
      list: true,
      links: "unlinked",
      hide: ["top", "Abc123", "000000"],
      q: " Kühl ",
    } satisfies GraphViewState,
  ]) {
    const next = writeGraphViewState(url, state);
    expect(next).not.toBe(url);
    expect(parseGraphViewState(next.searchParams)).toEqual(state);
    expect([...next.searchParams].slice(0, 7)).toEqual([
      ["mode", "graph"],
      ["note", "abc123"],
      ["from", "book"],
      ["back", "/x"],
      ["view", "favorites"],
      ["tag", "x"],
      ["folder", "abc123"],
    ]);
    expect(next.hash).toBe("#graph");
    expect(next.searchParams.get("display")).toBe(state.display);
  }
  expect(url.href).toBe(original);
});
test("writing removes stale params and empty values, preserving unrelated duplicates in order", () => {
  const url = new URL(
    "https://cloud.example/?mode=graph&display=local&view=favorites&tag=a&sort=changed&list=1&links=linked&hide=top&q=x&tag=b&view=tag&folder=a&folder=b&display=network",
  );
  const next = writeGraphViewState(url, { ...defaults, q: "   " });
  expect([...next.searchParams]).toEqual([
    ["mode", "graph"],
    ["view", "favorites"],
    ["tag", "a"],
    ["tag", "b"],
    ["view", "tag"],
    ["folder", "a"],
    ["folder", "b"],
  ]);
  expect(next.search).not.toContain("=&");
});
test("search is capped at 200 characters and remains untrimmed", () => {
  expect(GRAPH_QUERY_MAX).toBe(200);
  expect(parse(`q=${"x".repeat(250)}`).q).toHaveLength(GRAPH_QUERY_MAX);
  expect(parse("q=%20K%C3%BChl%20").q).toBe(" Kühl ");
  const next = writeGraphViewState(new URL("https://cloud.example/"), { ...defaults, q: "x".repeat(250) });
  expect(next.searchParams.get("q")).toHaveLength(GRAPH_QUERY_MAX);
});
test("hidden area keys are validated and deduped in first-seen order, also beyond 64 areas", () => {
  const keys = Array.from({ length: 70 }, (_, index) => index.toString(36).padStart(6, "0"));
  const hide = ["top", "bad", "Abc123", "top", "Abc123", "!bad", "ümlaut", "top ", ...keys];
  const expected = ["top", "Abc123", ...keys];
  expect(parse(`hide=${hide.join(",")}`).hide).toEqual(expected);
  const next = writeGraphViewState(new URL("https://cloud.example/"), { ...defaults, hide });
  expect(parseGraphViewState(next.searchParams).hide).toEqual(expected);
});
test("normalization applies parser limits without mutating the input", () => {
  const keys = Array.from({ length: 70 }, (_, index) => index.toString(36).padStart(6, "0"));
  const state: GraphViewState = {
    ...defaults,
    list: true,
    links: "linked",
    q: ` Kühl ${"x".repeat(244)}`,
    hide: ["top", "bad", "Abc123", "top", "Abc123", "!bad", "ümlaut", "top ", ...keys],
  };
  const original = structuredClone(state);
  const normalized = normalizeGraphViewState(state);
  expect(normalized).toEqual({
    ...state,
    q: state.q.slice(0, GRAPH_QUERY_MAX),
    hide: ["top", "Abc123", ...keys],
  });
  expect(normalizeGraphViewState(normalized)).toEqual(normalized);
  expect(parse(`q=${encodeURIComponent(state.q)}&hide=${state.hide.join(",")}&list=1&links=linked`)).toEqual(normalized);
  expect(state).toEqual(original);
  // Exercise invalid runtime input that the TypeScript type excludes.
  // @ts-expect-error Unknown displays must fall back to the default.
  expect(normalizeGraphViewState({ ...defaults, display: "local" })).toEqual(defaults);
});
test("writing and parsing round trips normalized oversized state", () => {
  const state: GraphViewState = {
    ...defaults,
    list: true,
    links: "unlinked",
    q: "x".repeat(250),
    hide: Array.from({ length: 70 }, (_, index) => index.toString(36).padStart(6, "0")),
  };
  const next = writeGraphViewState(new URL("https://cloud.example/?display=local"), state);
  expect(parseGraphViewState(next.searchParams)).toEqual(normalizeGraphViewState(state));
  expect(next.searchParams.has("display")).toBe(false);
});
test("whitespace-only queries normalize untrimmed but serialize as absent", () => {
  const state = { ...defaults, q: " \t\n " };
  expect(normalizeGraphViewState(state).q).toBe(state.q);
  expect(parse(`q=${encodeURIComponent(state.q)}`).q).toBe(state.q);
  const next = writeGraphViewState(new URL("https://cloud.example/?q=stale"), state);
  expect(next.searchParams.has("q")).toBe(false);
  expect(parseGraphViewState(next.searchParams)).toEqual({ ...normalizeGraphViewState(state), q: "" });
});
test("normalizing applies the URL limits, so a reload restores exactly what renders", () => {
  const hide = Array.from({ length: 70 }, (_, index) => index.toString(36).padStart(6, "0"));
  const state: GraphViewState = { ...defaults, list: true, hide: ["!bad", ...hide], q: "y".repeat(250) };
  const normalized = normalizeGraphViewState(state);
  expect(normalized.q).toHaveLength(200);
  expect(normalized.hide).toEqual(hide);
  expect(parseGraphViewState(writeGraphViewState(new URL("https://cloud.example/"), state).searchParams)).toEqual(normalized);
  expect(normalizeGraphViewState(normalized)).toEqual(normalized);
});

test("display absence round trips while explicit choices always survive every device", () => {
  expect(DEFAULT_GRAPH_DISPLAY).toBe("network");
  expect(PHONE_GRAPH_DISPLAY).toBe("neighborhood");
  expect(PHONE_GRAPH_QUERY).toBe("(max-width: 47.999rem)");
  expect(resolveGraphDisplay(null, null)).toBeNull();
  expect(resolveGraphDisplay(null, true)).toBe(PHONE_GRAPH_DISPLAY);
  expect(resolveGraphDisplay(null, false)).toBe(DEFAULT_GRAPH_DISPLAY);
  for (const display of ["network", "circle", "neighborhood", "timeline"] as const) {
    const next = writeGraphViewState(new URL("https://cloud.example/?display=invalid"), { ...defaults, display });
    expect(next.searchParams.get("display")).toBe(display);
    expect(parseGraphViewState(next.searchParams).display).toBe(display);
    for (const phone of [null, true, false]) expect(resolveGraphDisplay(display, phone)).toBe(display);
  }
  expect(parse("").display).toBeNull();
  expect(parse("display=bad").display).toBeNull();
  expect(writeGraphViewState(new URL("https://cloud.example/?display=network"), defaults).searchParams.has("display")).toBe(false);
});
test("only depth=1 selects one step; the default two steps serialize without a parameter", () => {
  for (const depth of ["", "0", "2", "3", "01", "garbage"]) expect(parse(`depth=${depth}`).depth).toBe(2);
  expect(parse("depth=1").depth).toBe(1);
  for (const depth of [1, 2] as const) {
    const next = writeGraphViewState(new URL("https://cloud.example/?depth=bad"), { ...defaults, depth });
    expect(next.searchParams.get("depth")).toBe(depth === 1 ? "1" : null);
    expect(parseGraphViewState(next.searchParams).depth).toBe(depth);
  }
});

test("only the supported change sorts round trip, and null removes the sort", () => {
  for (const sort of ["changed", "changed-asc"] as const) {
    expect(parse(`sort=${sort}`)).toEqual({ ...defaults, sort });
    const next = writeGraphViewState(new URL("https://cloud.example/"), { ...defaults, sort });
    expect(parseGraphViewState(next.searchParams).sort).toBe(sort);
  }
  expect(parse("sort=oldest")).toEqual(defaults);
  // @ts-expect-error Invalid runtime sort values normalize to tree order.
  expect(normalizeGraphViewState({ ...defaults, sort: "oldest" })).toEqual(defaults);
  expect(writeGraphViewState(new URL("https://cloud.example/?sort=changed"), defaults).searchParams.has("sort")).toBe(false);
  expect(parse("display=timeline").display).toBe("timeline");
});
