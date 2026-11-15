import { expect, test } from "bun:test";
import { highlightCodeDisplayLines, highlightSql } from "./code-highlight";

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
    expect(highlightCodeDisplayLines(source, "sql").join("\n")).toBe(html);
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
  expect(highlightCodeDisplayLines(source, "markdown")).toEqual([expected]);
  expect(highlightCodeDisplayLines(source, "md")).toEqual([expected]);
});

test.each(["ts", "tsx", "js", "jsx", "script"])("Markdown fences preserve %s language transitions", (language) => {
  expect(highlightCodeDisplayLines(`\`\`\`${language} title\nconst answer = 42;\n\`\`\`\nconst answer = 42;`, "markdown")).toEqual([
    `<span class="cd-md-syntax">\`\`\`</span><span class="cd-md-ref">${language} title</span>`,
    '<span class="hl-keyword">const</span> answer <span class="hl-operator">=</span> <span class="hl-number">42</span>;',
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
    expect(highlightCodeDisplayLines(source, "markdown")).toEqual([expected]);
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

test("TypeScript comes from the stdlib code preset, escaped, with one balanced line per source line", () => {
  const source = "const a = `x\n${b}`; /* one\ntwo */\nif (a < 2) return '<img src=x>';";
  const lines = highlightCodeDisplayLines(source, "ts");
  expect(lines).toEqual([
    '<span class="hl-keyword">const</span> a <span class="hl-operator">=</span> <span class="hl-string">`x</span>',
    '<span class="hl-string">${b}`</span>; <span class="hl-comment">/* one</span>',
    '<span class="hl-comment">two */</span>',
    '<span class="hl-keyword">if</span> (a <span class="hl-operator">&lt;</span> <span class="hl-number">2</span>) <span class="hl-keyword">return</span> <span class="hl-string">&#39;&lt;img src=x&gt;&#39;</span>;',
  ]);
  for (const language of ["js", "jsx", "tsx", "script"] as const) expect(highlightCodeDisplayLines(source, language)).toEqual(lines);
  // An empty line keeps its height; a token never leaves an empty span behind.
  expect(highlightCodeDisplayLines("/* a\n\n*/", "ts")).toEqual([
    '<span class="hl-comment">/* a</span>',
    " ",
    '<span class="hl-comment">*/</span>',
  ]);
});

// About 75,000 characters each; the former regular expressions took seconds on the unterminated ones (#3205, stdlib 0.32.2).
for (const [name, source] of [
  ["ordinary code", "const value = await fetch(`/api/${id}`, { method: 'POST' }); // note\n".repeat(1_100)],
  ["open block comments", "/*a".repeat(25_000)],
  ["open strings", "'a\"b`c".repeat(12_500)],
  ["open template strings", "`a${".repeat(18_750)],
] as const) {
  test(`TypeScript highlighting stays fast on long ${name}`, () => {
    highlightCodeDisplayLines("const warm = `up`; /* x */", "ts");
    const started = performance.now();
    const lines = highlightCodeDisplayLines(source, "ts");
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1_000);
    expect(lines).toHaveLength(source.split("\n").length);
    expect(
      lines
        .map((line) => (line === " " ? "" : line))
        .join("\n")
        .replace(/<\/?span[^>]*>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&"),
    ).toBe(source);
  });
}
