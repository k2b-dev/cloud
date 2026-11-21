import { expect, test } from "bun:test";
import { AI_LIVE_ARG_TAIL_CHARS, createLiveArgsReader } from "./live-tool-args";

const readAll = (fragments: readonly string[], keys = ["path", "content"], limit?: number) => {
  const reader = createLiveArgsReader(keys, limit);
  for (const fragment of fragments) reader.push(fragment);
  return reader.view();
};

const json = JSON.stringify({
  project: { files: { "a.ts": "nested", content: "never" } },
  path: "src/code.ts",
  list: ["content", { content: "x" }],
  content: 'const quote = "\\"";\n\ttab\u00e9 \ud83d\ude00 \\u0041\nend',
  count: 3,
});

test("each fragment split reads the same values as JSON.parse, also cut inside escapes and surrogates", () => {
  const parsed = JSON.parse(json) as { path: string; content: string };
  const expected = { args: { path: parsed.path, content: parsed.content }, omittedLines: { path: 0, content: 0 } };
  expect(readAll([json])).toEqual(expected);
  expect(readAll([...json])).toEqual(expected);
  for (let cut = 1; cut < json.length; cut += 1) expect(readAll([json.slice(0, cut), json.slice(cut)])).toEqual(expected);
});

test("an unfinished value shows as far as it is written; an escape cut in half waits for its rest", () => {
  expect(readAll(['{"path":"a.ts","content":"one\\'])).toEqual({
    args: { path: "a.ts", content: "one" },
    omittedLines: { path: 0, content: 0 },
  });
  expect(readAll(['{"content":"\\u00'])).toEqual({ args: { content: "" }, omittedLines: { content: 0 } });
  // A key still being written has no value yet.
  expect(readAll(['{"path":"a.ts","cont'])).toEqual({ args: { path: "a.ts" }, omittedLines: { path: 0 } });
});

test("a repeated key starts over, as JSON.parse keeps the last value", () => {
  expect(readAll(['{"path":"old.ts","path":"new.ts"}']).args).toEqual({ path: "new.ts" });
});

test("a long value keeps only its end, starting at a line, and counts every line before it", () => {
  const lines = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`);
  const value = lines.join("\n");
  const fragments = JSON.stringify({ content: value }).match(/[\s\S]{1,13}/g) ?? [];
  const view = readAll(fragments, ["content"]);
  const shown = view.args.content ?? "";
  expect(shown.length).toBeLessThanOrEqual(AI_LIVE_ARG_TAIL_CHARS);
  expect(shown.startsWith("line ")).toBe(true);
  expect(shown.endsWith("line 5000")).toBe(true);
  expect(view.omittedLines.content).toBe(5000 - shown.split("\n").length);
  expect(lines[view.omittedLines.content ?? 0]).toBe(shown.split("\n")[0]);
});

test("a repeated key with any other value drops the earlier string", () => {
  for (const value of ["{}", "[]", "null", "3", "true"]) expect(readAll([`{"content":"old","content":${value}}`]).args).toEqual({});
});

test("a cut never leaves half of a surrogate pair", () => {
  const value = `😀${"x".repeat(AI_LIVE_ARG_TAIL_CHARS - 1)}`;
  for (const fragments of [
    [JSON.stringify({ content: value })],
    [JSON.stringify({ content: value + "y".repeat(AI_LIVE_ARG_TAIL_CHARS + 7) })],
  ]) {
    const shown = readAll(fragments, ["content"]).args.content ?? "";
    const first = shown.charCodeAt(0);
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
  }
});

test("one huge fragment reads the same end as many small ones", () => {
  const json = JSON.stringify({ content: Array.from({ length: 40_000 }, (_, index) => `row ${index}`).join("\n") });
  expect(readAll([json], ["content"])).toEqual(readAll(json.match(/[\s\S]{1,9}/g) ?? [], ["content"]));
});
