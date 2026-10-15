import { describe, expect, test } from "bun:test";
import { hasEscapedLineBreak } from "./escaped-line-break";

describe("hasEscapedLineBreak", () => {
  test("flags unescaped backslash-n outside inline code", () => {
    for (const text of ["Caption:\\nText", "a\\r\\nb", "a\\\\\\nb", "`code` then \\n", "``unmatched \\n`"])
      expect(hasEscapedLineBreak(text), text).toBeTrue();
  });

  test("allows real line breaks, inline code, and escaped backslashes", () => {
    for (const text of [
      "",
      "Plain text",
      "\\`code`n",
      "Caption:\nText",
      "a\rb",
      "a\\n\nb",
      "`\\n`",
      "``split ` on \\n``",
      "a\\\\nb",
      "a\\\\\\\\nb",
    ])
      expect(hasEscapedLineBreak(text), text).toBeFalse();
  });
});
