import { expect, test } from "bun:test";
import {
  DEFAULT_GRAPH_DISPLAY,
  GRAPH_QUERY_MAX,
  type GraphViewState,
  normalizeGraphViewState,
  parseGraphViewState,
  writeGraphViewState,
} from "./view-state";

const defaults: GraphViewState = { display: DEFAULT_GRAPH_DISPLAY, list: false, links: "all", hide: [], q: "" };
const parse = (query: string) => parseGraphViewState(new URLSearchParams(query));
test("empty and invalid view state falls back to defaults", () => {
  expect(parse("")).toEqual(defaults);
  expect(parse("display=local&list=true&links=nope&hide=bad,toolong,!,12345&extra=1")).toEqual(defaults);
  expect(parse("display=network")).toEqual(defaults);
  expect(parse("view=favorites&display=network&list=1&links=linked")).toEqual({ ...defaults, list: true, links: "linked" });
});
test("normalized states round trip without changing the URL or other params", () => {
  const url = new URL(
    "https://cloud.example/app/notebooks/book01?mode=graph&note=abc123&from=book&back=%2Fx&view=favorites&tag=x&folder=abc123#graph",
  );
  const original = url.href;
  for (const state of [
    defaults,
    { display: "network", list: true, links: "unlinked", hide: ["top", "Abc123", "000000"], q: " Kühl " } satisfies GraphViewState,
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
    expect(next.searchParams.has("display")).toBe(false);
  }
  expect(url.href).toBe(original);
});
test("writing removes stale params and empty values, preserving unrelated duplicates in order", () => {
  const url = new URL(
    "https://cloud.example/?mode=graph&display=local&view=favorites&tag=a&list=1&links=linked&hide=top&q=x&tag=b&view=tag&folder=a&folder=b&display=network",
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
test("hidden area keys are validated, deduped and capped in first-seen order", () => {
  const keys = Array.from({ length: 70 }, (_, index) => index.toString(36).padStart(6, "0"));
  const hide = ["top", "bad", "Abc123", "top", "Abc123", "!bad", "ümlaut", "top ", ...keys];
  const expected = ["top", "Abc123", ...keys].slice(0, 64);
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
    hide: ["top", "Abc123", ...keys].slice(0, 64),
  });
  expect(normalizeGraphViewState(normalized)).toEqual(normalized);
  expect(parse(`q=${encodeURIComponent(state.q)}&hide=${state.hide.join(",")}&display=network&list=1&links=linked`)).toEqual(normalized);
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
  expect(normalized.hide).toEqual(hide.slice(0, 64));
  expect(parseGraphViewState(writeGraphViewState(new URL("https://cloud.example/"), state).searchParams)).toEqual(normalized);
  expect(normalizeGraphViewState(normalized)).toEqual(normalized);
});
