import { expect, test } from "bun:test";
import { highlightCodeDisplay, highlightCodeDisplayLines, highlightSql } from "./code-highlight";

test("SQL highlighting escapes HTML and preserves every source character", () => {
  for (const source of [
    "SELECT '<img src=x onerror=alert(1)>', :host",
    "SELECT `:hidden`, ':also_hidden', x::String -- :comment\r :hidden\n, :p",
    "/* outer /* inner */ :hidden */ SELECT 1",
    "SELECT 'unfinished",
    'SELECT "a""b"',
  ]) {
    const html = highlightSql(source);
    expect(html).not.toContain("<img");
    expect(
      html
        .replace(/<\/?span[^>]*>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
    ).toBe(source);
    expect(highlightCodeDisplay(source, "sql")).toBe(html);
  }
});
test("SQL parameters are not highlighted inside literals, identifiers, comments or casts", () => {
  const source = "SELECT ':no', `:no`, x::String -- :no\r :no\n, :yes";
  expect(highlightSql(source).match(/class="cd-a"/g)).toHaveLength(1);
  expect(highlightSql(source)).toContain('<span class="cd-a">:yes</span>');
});

test("multiline SQL tokens produce balanced highlighting on each display line", () => {
  for (const source of ["/* comment\nnext */ SELECT 1", "SELECT 'one\ntwo'", 'SELECT "one\ntwo"']) {
    const lines = highlightCodeDisplayLines(source, "sql");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.match(/<span /g)?.length ?? 0).toBe(line.match(/<\/span>/g)?.length ?? 0);
  }
});
