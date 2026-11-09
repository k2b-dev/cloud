import { expect, test } from "bun:test";
import { blockMathPattern, inlineMathPattern } from "./math-syntax";

test("an unclosed pasted bracket cannot consume a later display formula", () => {
  const text = "\\[Chorus]\n\n\\[x + 1\\]";
  expect([...text.matchAll(blockMathPattern())].map((match) => match[0])).toEqual(["\\[x + 1\\]"]);
});

test("an unclosed parenthesis cannot consume a later inline formula", () => {
  const text = "\\(literal note \\(x + 1\\)";
  expect([...text.matchAll(inlineMathPattern())].map((match) => match[0])).toEqual(["\\(x + 1\\)"]);
});

test("math keeps ordinary LaTeX backslash commands", () => {
  expect([...String.raw`\[\frac{1}{2} + \sqrt{x}\]`.matchAll(blockMathPattern())].map((match) => match[2])).toEqual([
    String.raw`\frac{1}{2} + \sqrt{x}`,
  ]);
});
