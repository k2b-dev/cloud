import { describe, expect, test } from "bun:test";
import { findLigatures, frontMatterLength, LIGATURES, ligatureHtml } from "./ligatures";

const symbols = (text: string) => findLigatures(text).map((match) => match.symbol);

describe("display ligatures", () => {
  test("every sequence maps to its symbol in prose", () => {
    const expected: Record<string, string> = {
      "->": "→",
      "<-": "←",
      "<->": "↔",
      "=>": "⇒",
      "<=": "≤",
      ">=": "≥",
      "!=": "≠",
      "<=>": "⇔",
      "+-": "±",
      "(c)": "©",
      "(C)": "©",
      "(r)": "®",
      "(R)": "®",
      "(tm)": "™",
      "(TM)": "™",
      "...": "…",
      "--": "–",
    };
    expect(Object.fromEntries(LIGATURES.map(({ source, symbol }) => [source, symbol]))).toEqual(expected);
    for (const [source, symbol] of Object.entries(expected)) {
      expect(findLigatures(`a ${source} b`)).toEqual([{ from: 2, to: 2 + source.length, source, symbol }]);
    }
  });

  test("the longest sequence wins", () => {
    expect(symbols("a <-> b <=> c")).toEqual(["↔", "⇔"]);
    expect(symbols("a<->b")).toEqual(["↔"]);
  });

  test("arrows work without spaces but not inside longer operator runs", () => {
    expect(symbols("a<-b, a->b, x>=1, x<=1, x!=1, +-5")).toEqual(["←", "→", "≥", "≤", "≠", "±"]);
    for (const text of ["a --> b", "a <-- b", "a ==> b", "a <== b", "x !== y", "x >>= 1", "x <<= 1", "<-->", "<==>", "a ~= b"]) {
      expect(symbols(text)).toEqual([]);
    }
  });

  test("HTML comments, rules, flags and word-glued letters stay literal", () => {
    for (const text of ["<!-- note -->", "---", "--flag", "a--b", "f(c)", "(c)2026", "x(r)", "....", "1/2", "3x4", "0x1F", "a ~= b"]) {
      expect(symbols(text)).toEqual([]);
    }
    expect(symbols("(c) 2026 Ada (tm).")).toEqual(["©", "™"]);
    expect(symbols("Notebooks(tm) and Cloud(TM), but not (tm)x")).toEqual(["™", "™"]);
    expect(symbols("Wait... what")).toEqual(["…"]);
  });

  test("neighbours outside the scanned window still guard a match", () => {
    expect(findLigatures("a --> b", 3)).toEqual([]);
    expect(findLigatures("a -> b", 0, 3)).toEqual([]);
  });

  test("HTML output escapes text and keeps the typed characters in the title", () => {
    expect(ligatureHtml("<b> -> & &amp; (c)")).toBe(
      '&lt;b&gt; <span class="notebook-ligature" title="-&gt;">→</span> &amp; &amp; <span class="notebook-ligature" title="(c)">©</span>',
    );
  });

  test("front matter needs an opening and a closing fence at the start", () => {
    expect(frontMatterLength("---\ntitle: a -> b\n---\nBody")).toBe(22);
    expect(frontMatterLength("---\ntitle: x\n...\n")).toBe(17);
    expect(frontMatterLength("Intro\n---\ntitle: x\n---\n")).toBe(0);
    expect(frontMatterLength("---\nno closing fence")).toBe(0);
  });
});
