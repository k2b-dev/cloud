import { expect, test } from "bun:test";
import { localCloudResourceUrl, matchCloudResourcePage, resourcePageIssue } from "./resource-pages";

const page = (type: string, path: string) => ({ type: `demo.${type}`, path, prefixes: ["/app/demo"] });
const pages = [page("base", "/app/demo/:id"), page("item", "/app/demo/:base?item=:id")];

test("required query keys outrank base pages; extra params, fragments and a trailing slash are ignored", () => {
  expect(matchCloudResourcePage("/app/demo/base/?item=a%2Fb&extra=yes#part", pages)).toEqual({ type: "demo.item", id: "a/b" });
  expect(matchCloudResourcePage("/app/demo/base?other=value", pages)).toEqual({ type: "demo.base", id: "base" });
  expect(matchCloudResourcePage("/app/demo/base?item=", [pages[1]!])).toBeNull();
  expect(matchCloudResourcePage("/app/demo/base?item=a&item=b", [pages[1]!])).toBeNull();
});

test("more literal segments win; patterns do not interpret regular expressions", () => {
  expect(
    matchCloudResourcePage("/app/demo/public/a", [page("generic", "/app/demo/:id/:view"), page("public", "/app/demo/public/:id")]),
  ).toEqual({ type: "demo.public", id: "a" });
  expect(matchCloudResourcePage("/app/demo/a+b/東京", [page("item", "/app/demo/a+b/:id")])).toEqual({ type: "demo.item", id: "東京" });
  expect(matchCloudResourcePage("/app/demo/aaab/id", [page("item", "/app/demo/a+b/:id")])).toBeNull();
});

test("equal best scores for different refs fail closed, regardless of declaration order", () => {
  const tied = [page("first", "/app/demo/:id/:tail"), page("second", "/app/demo/:base/:id")];
  expect(matchCloudResourcePage("/app/demo/a/b", tied)).toBeNull();
  expect(matchCloudResourcePage("/app/demo/a/b", tied.toReversed())).toBeNull();
  expect(matchCloudResourcePage("/app/demo/a", [pages[0]!, pages[0]!])).toEqual({ type: "demo.base", id: "a" });
  expect(
    matchCloudResourcePage("/app/demo/a?item=b&tag=c", [page("item", "/app/demo/:base?item=:id"), page("tag", "/app/demo/:base?tag=:id")]),
  ).toBeNull();
});

test("query literals and all captures must match, with percent-decoding exactly once", () => {
  const candidates = [page("item", "/app/demo/:base?kind=note&item=:id")];
  expect(matchCloudResourcePage("/app/demo/b?item=%252F&kind=note", candidates)).toEqual({ type: "demo.item", id: "%2F" });
  expect(matchCloudResourcePage("/app/demo/b?item=a&kind=other", candidates)).toBeNull();
  expect(matchCloudResourcePage("/app/demo//?item=a&kind=note", candidates)).toBeNull();
});

test.each(["/app/demo/%ZZ", "/app/demo/%E0%A4", "/app/demo/a?item=%ZZ", "/app/demo/a?%ZZ=ok", "//other/app/demo/a", "/app/demo/a\\b"])(
  "rejects malformed input %s",
  (path) => {
    expect(matchCloudResourcePage(path, pages)).toBeNull();
  },
);

test("prefix ownership uses complete literal segments", () => {
  for (const path of ["/app/foreign/:id", "/app/demo-other/:id", "/app/:app/:id", "/app/demo/../foreign/:id", "/app/demo/%2e%2e/:id"])
    expect(resourcePageIssue(path, ["/app/demo"])).not.toBeNull();
  expect(resourcePageIssue("/app/demo/:id", ["/app/demo"])).toBeNull();
  expect(matchCloudResourcePage("/app/foreign/id", [page("item", "/app/foreign/:id")])).toBeNull();
});

test.each([
  "/app/demo/literal",
  "/app/demo/:id/:id",
  "/app/demo/prefix-:id",
  "/app/demo/:id#fragment",
  "/app/demo/:id?item=:id",
  "/app/demo/:id?key=a&key=b",
  "/app/demo/:id?broken",
  "/app/demo/:id?key=a?key=b",
  `/app/demo/${"a".repeat(300)}/:id`,
])("validates declaration syntax %s", (path) => {
  expect(resourcePageIssue(path)).not.toBeNull();
});

test.each([
  "https://other.example/app/demo/a",
  "//cloud.example/app/demo/a",
  "javascript:alert(1)",
  "data:text/plain,a",
  "https://cloud.example@other.example/a",
  "https://user@cloud.example/a",
  "/\\other.example/a",
  "/app/demo/a another",
  "/".repeat(8193),
])("rejects nonlocal or multiple URL tokens", (value) => {
  expect(localCloudResourceUrl(value, "https://cloud.example")).toBeNull();
});

test("canonical origin may differ from the current gateway alias; unset origin only accepts relative URLs", () => {
  expect(localCloudResourceUrl("https://cloud.example/a", "https://cloud.example")?.pathname).toBe("/a");
  expect(localCloudResourceUrl("/a", null)?.pathname).toBe("/a");
  expect(localCloudResourceUrl("https://cloud.example/a", null)).toBeNull();
});

test("root-owned applications can declare root query pages", () => {
  const root = { type: "demo.item", path: "/?item=:id", prefixes: ["/"] };
  expect(resourcePageIssue(root.path, root.prefixes)).toBeNull();
  expect(matchCloudResourcePage("/?item=a", [root])).toEqual({ type: "demo.item", id: "a" });
});

test("query specificity outranks more literal segments, and two required keys outrank one", () => {
  const generic = page("query", "/app/demo/:base/:view?item=:id");
  const literal = page("literal", "/app/demo/public/:id");
  const scoped = page("scoped", "/app/demo/:base/:view?item=:id&kind=note");
  expect(matchCloudResourcePage("/app/demo/public/a?item=b", [literal, generic])).toEqual({ type: "demo.query", id: "b" });
  expect(matchCloudResourcePage("/app/demo/public/a?item=b&kind=note", [generic, scoped, literal])).toEqual({
    type: "demo.scoped",
    id: "b",
  });
});

test("an ancestor prefix cannot claim another app's reserved namespace", () => {
  expect(resourcePageIssue("/app/foreign/:id", ["/"], "demo")).not.toBeNull();
  expect(resourcePageIssue("/app/:app/:id", ["/"], "demo")).not.toBeNull();
  expect(matchCloudResourcePage("/app/foreign/id", [{ type: "demo.item", path: "/app/foreign/:id", prefixes: ["/"] }])).toBeNull();
});
