import { expect, test } from "bun:test";
import { DEFAULT_GRAPH_DISPLAY, type GraphViewState, parseGraphViewState, writeGraphViewState } from "./view-state";

const defaults: GraphViewState = { view: DEFAULT_GRAPH_DISPLAY, list: false, links: "all", hide: [], q: "" };
const parse = (query: string) => parseGraphViewState(new URLSearchParams(query));
test("empty and invalid view state falls back to defaults", () => {
  expect(parse("")).toEqual(defaults);
  expect(parse("view=local&list=true&links=nope&hide=bad,toolong,!,12345&extra=1")).toEqual(defaults);
  expect(parse("view=network&list=1&links=linked")).toEqual({ ...defaults, list: true, links: "linked" });
});
test("normalized states round trip without changing the URL or other params", () => {
  const url = new URL("https://cloud.example/app/notebooks/book01?mode=graph&note=abc123&from=book&back=%2Fx&tag=a#graph");
  const original = url.href;
  for (const state of [
    defaults,
    { view: "network", list: true, links: "unlinked", hide: ["top", "Abc123", "000000"], q: " Kühl " } satisfies GraphViewState,
  ]) {
    const next = writeGraphViewState(url, state);
    expect(next).not.toBe(url);
    expect(parseGraphViewState(next.searchParams)).toEqual(state);
    expect([...next.searchParams].slice(0, 5)).toEqual([
      ["mode", "graph"],
      ["note", "abc123"],
      ["from", "book"],
      ["back", "/x"],
      ["tag", "a"],
    ]);
    expect(next.hash).toBe("#graph");
    expect(next.searchParams.has("view")).toBe(false);
  }
  expect(url.href).toBe(original);
});
test("writing removes stale params and empty values, preserving unrelated duplicates in order", () => {
  const url = new URL("https://cloud.example/?mode=graph&view=local&tag=a&list=1&links=linked&hide=top&q=x&tag=b&view=circle");
  const next = writeGraphViewState(url, { ...defaults, q: "   " });
  expect([...next.searchParams]).toEqual([
    ["mode", "graph"],
    ["tag", "a"],
    ["tag", "b"],
  ]);
  expect(next.search).not.toContain("=&");
});
test("search is capped at 200 characters and remains untrimmed", () => {
  expect(parse(`q=${"x".repeat(250)}`).q).toHaveLength(200);
  expect(parse("q=%20K%C3%BChl%20").q).toBe(" Kühl ");
  const next = writeGraphViewState(new URL("https://cloud.example/"), { ...defaults, q: "x".repeat(250) });
  expect(next.searchParams.get("q")).toHaveLength(200);
});
test("hidden area keys are validated, deduped and capped in first-seen order", () => {
  const keys = Array.from({ length: 70 }, (_, index) => index.toString(36).padStart(6, "0"));
  const hide = ["top", "bad", "Abc123", "top", "Abc123", "!bad", "ümlaut", "top ", ...keys];
  const expected = ["top", "Abc123", ...keys].slice(0, 64);
  expect(parse(`hide=${hide.join(",")}`).hide).toEqual(expected);
  const next = writeGraphViewState(new URL("https://cloud.example/"), { ...defaults, hide });
  expect(parseGraphViewState(next.searchParams).hide).toEqual(expected);
});
