import { expect, test } from "bun:test";
import { highlightCodeDisplay, highlightCodeDisplayLines, highlightMarkdownDisplay, highlightSql } from "./code-highlight";

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
  expect(highlightSql(source).match(/class="cd-a cd-param"/g)).toHaveLength(1);
  expect(highlightSql(source)).toContain('<span class="cd-a cd-param">:yes</span>');
});

test("multiline SQL tokens produce balanced highlighting on each display line", () => {
  for (const source of ["/* comment\nnext */ SELECT 1", "SELECT 'one\ntwo'", 'SELECT "one\ntwo"']) {
    const lines = highlightCodeDisplayLines(source, "sql");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.match(/<span /g)?.length ?? 0).toBe(line.match(/<\/span>/g)?.length ?? 0);
  }
});

test.each([
  [
    "  :::note-kind **hello** <&>",
    '<span class="cd-md-syntax">  :::</span><span class="cd-md-directive">note-kind</span> <span class="cd-md-syntax">**</span>hello<span class="cd-md-syntax">**</span> &lt;&amp;&gt;',
  ],
  [":::---", '<span class="cd-md-syntax">:::</span>---'],
  [":::a-b\r!", ":::a-b\r!"],
  ["*\t[ ]\titem", '<span class="cd-md-syntax">*\t</span><span class="cd-md-checkbox">[ ]</span>\titem'],
  [
    "  12. [X]  **done**",
    '<span class="cd-md-syntax">  12. </span><span class="cd-md-checkbox">[X]</span>  <span class="cd-md-syntax">**</span>done<span class="cd-md-syntax">**</span>',
  ],
  ["- [x]", '<span class="cd-md-syntax">- </span>[x]'],
  ["- [x] ", '<span class="cd-md-syntax">- </span><span class="cd-md-checkbox">[x]</span> '],
  ["+\t\titem", '<span class="cd-md-syntax">+\t\t</span>item'],
  ["1. \t", '<span class="cd-md-syntax">1. \t</span>'],
  ["1.item", "1.item"],
  ["- [x] \ttext\r!", "- [x] \ttext\r!"],
  ["- \ttext\r!", "- \ttext\r!"],
  ["```ts title", '<span class="cd-md-syntax">```</span><span class="cd-md-ref">ts title</span>'],
])("Markdown highlighting preserves exact output for %j", (source, expected) => {
  expect(highlightMarkdownDisplay(source)).toBe(expected);
  expect(highlightCodeDisplay(source, "markdown")).toBe(expected);
  expect(highlightCodeDisplayLines(source, "md")).toEqual([expected]);
});

test.each(["ts", "tsx", "js", "jsx", "script"])("Markdown fences preserve %s language transitions", (language) => {
  expect(highlightCodeDisplayLines(`\`\`\`${language} title\nconst answer = 42;\n\`\`\`\nconst answer = 42;`, "markdown")).toEqual([
    `<span class="cd-md-syntax">\`\`\`</span><span class="cd-md-ref">${language} title</span>`,
    '<span class="cd-k">const</span> <span class="cd-a">answer</span> = <span class="cd-n">42</span>;',
    '<span class="cd-md-syntax">```</span>',
    "const answer = 42;",
  ]);
});

test.each(["\r", "\u2028", "\u2029"])("Markdown preserves existing line-terminator handling for %j", (ending) => {
  for (const [source, expected] of [
    [`:::note${ending}`, `:::note${ending}`],
    [`- item${ending}`, `- item${ending}`],
    [`- [x] item${ending}`, `- [x] item${ending}`],
    [`- [x] ${ending}`, `<span class="cd-md-syntax">- </span><span class="cd-md-checkbox">[x]</span> ${ending}`],
    [`- ${ending}`, `<span class="cd-md-syntax">- ${ending}</span>`],
  ] as const) {
    expect(highlightMarkdownDisplay(source)).toBe(expected);
  }
  expect(highlightCodeDisplayLines(`\`\`\`ts${ending}\nconst answer = 42;`, "markdown")).toEqual([
    `\`\`\`ts${ending}`,
    "const answer = 42;",
  ]);
});

for (const [name, source] of [
  ["directive name", `:::a${"-".repeat(75_000)}\r!`],
  ["task whitespace", `*\t[ ]\t${"\t".repeat(75_000)}text\r!`],
  ["list whitespace", `*\t${"\t".repeat(75_000)}text\r!`],
  ["fence language", `\`\`\`${"00".repeat(37_500)}\r!`],
] as const) {
  test(`Markdown highlighting stays fast on long repetitive ${name}`, () => {
    // Warm the public path without the long input. The bound leaves ample room
    // for scheduling noise, while the former repeated retries take seconds.
    highlightCodeDisplayLines(":::note\n* [ ] item\n- item\n```ts", "markdown");
    const started = performance.now();
    const lines = highlightCodeDisplayLines(source, "markdown");
    const elapsed = performance.now() - started;
    expect(lines).toHaveLength(1);
    expect(elapsed).toBeLessThan(1_000);
    expect(lines[0]).toBe(source);
  });
}
