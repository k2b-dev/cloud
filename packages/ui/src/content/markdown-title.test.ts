import { describe, expect, test } from "bun:test";
import { leadingMarkdownTitle } from "./markdown-title";

describe("leadingMarkdownTitle", () => {
  test("lifts a leading ATX heading as plain text and returns the rest", () => {
    expect(leadingMarkdownTitle("# Summer *party* 2026\n\nBring a `chair` & [snacks](https://example.test).\n")).toEqual({
      title: "Summer party 2026",
      body: "\n\nBring a `chair` & [snacks](https://example.test).\n",
    });
  });

  test("skips leading blank lines and reads a setext heading", () => {
    expect(leadingMarkdownTitle("\n\nPacking list\n============\nTent\n")).toEqual({ title: "Packing list", body: "Tent\n" });
  });

  test("decodes entities and keeps code, escapes and raw HTML as they read", () => {
    expect(leadingMarkdownTitle("# Tom &amp; Jerry &#8211; `a<b` \\* <b>x</b>\nText")?.title).toBe("Tom & Jerry – a<b * <b>x</b>");
  });

  test("normalizes Windows line endings in the returned body", () => {
    expect(leadingMarkdownTitle("# Notes\r\n\r\nFirst line\r\n")).toEqual({ title: "Notes", body: "\n\nFirst line\n" });
  });

  test("returns null unless the first block is a level-one heading with text", () => {
    expect(leadingMarkdownTitle("## Section\n# Title")).toBeNull();
    expect(leadingMarkdownTitle("Intro\n\n# Title")).toBeNull();
    expect(leadingMarkdownTitle("<!-- note -->\n# Title")).toBeNull();
    expect(leadingMarkdownTitle("#\n\nText")).toBeNull();
    expect(leadingMarkdownTitle("")).toBeNull();
  });
});
