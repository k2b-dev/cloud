import { describe, expect, spyOn, test } from "bun:test";
import { htmlToReadableMarkdown } from "./readable-html";

const baseUrl = new URL("https://example.test/articles/2026/page.html");
const convert = (html: string, options: { maxBytes?: number; signal?: AbortSignal; contentType?: string } = {}) =>
  htmlToReadableMarkdown(new TextEncoder().encode(html), { baseUrl, maxBytes: 1024 * 1024, ...options });

describe("readable HTML", () => {
  test.each([
    ["paragraph", "<p>", "</p>", "", ""],
    ["link", '<a href="/guide">', "</a>", "[", "](https://example.test/guide)"],
    ["heading", "<h2>", "</h2>", "## ", ""],
    ["table cell", "<table><tr><td>", "</td></tr></table>", "| ", " |\n| --- |"],
    ["caption", "<table><caption>", "</caption></table>", "", ""],
  ])("escapes only HTML-like less-than signs in ordinary %s text", async (_name, start, end, prefix, suffix) => {
    expect(await convert(`${start}Use &lt;Widget&gt; instead of &lt;Legacy&gt;. a &lt; b${end}`)).toBe(
      `${prefix}Use \\<Widget> instead of \\<Legacy>. a < b${suffix}\n`,
    );
    expect(await convert(`${start}&lt;/div&gt; &lt;!doctype&gt; &lt;?xml&gt; &lt;3 &lt;= &lt;. &lt;${end}`)).toBe(
      `${prefix}\\</div> \\<!doctype> \\<?xml> <3 <= <. <${suffix}\n`,
    );
    expect(await convert(`${start}<code>&lt;div&gt;</code>${end}`)).toBe(`${prefix}\`<div>\`${suffix}\n`);
  });

  test("escapes literal markup in image alt text and fallback titles while preserving preformatted code", async () => {
    expect(await convert('<p><img src="/pic" alt="&lt;Widget&gt;"></p>')).toBe("![\\<Widget>](https://example.test/pic)\n");
    expect(await convert('<h2><img src="/pic" alt="&lt;Widget&gt;"></h2>')).toBe("## ![\\<Widget>](https://example.test/pic)\n");
    expect(await convert("<title>&lt;Widget&gt;</title><pre>&lt;div&gt;</pre>")).toBe("# \\<Widget>\n\n```\n<div>\n```\n");
  });

  test.each([
    ["heading", "<h2>", "</h2>", "## ", ""],
    ["link", '<a href="/guide">', "</a>", "[", "](https://example.test/guide)"],
    ["table cell", "<table><tr><td>", "</td></tr></table>", "| ", " |\n| --- |"],
    ["caption", "<table><caption>", "</caption></table>", "", ""],
  ])("keeps break and block boundaries inside inline code in a %s", async (_name, start, end, prefix, suffix) => {
    for (const separator of ["<br>", "<address></address>"]) {
      expect(await convert(`${start}<code>git status${separator}git diff</code>${end}`)).toBe(
        `${prefix}\`git status git diff\`${suffix}\n`,
      );
    }
  });

  test("pads every data row and its separator to the widest row, including later rows", async () => {
    expect(await convert("<table><tr><th>Name</th></tr><tr><td>A</td><td>IMPORTANT</td></tr></table>")).toBe(
      "| Name |  |\n| --- | --- |\n| A | IMPORTANT |\n",
    );
    expect(await convert("<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr><tr><td>D</td><td>E</td><td>F</td></tr></table>")).toBe(
      "| A | B |  |\n| --- | --- | --- |\n| C |  |  |\n| D | E | F |\n",
    );
  });

  test("charges buffered rows and widening against the output budget and flushes them on truncation", async () => {
    const stringify = spyOn(URL.prototype, "toString");
    try {
      const html = "<table><tr><th>Name</th></tr>" + '<tr><td>A</td><td><a href="/x">IMPORTANT</a></td></tr>'.repeat(10_000) + "</table>";
      const result = await htmlToReadableMarkdown(new TextEncoder().encode(html), {
        baseUrl,
        maxBytes: 1024,
        maxInputBytes: Buffer.byteLength(html),
      });
      expect(result).toStartWith("| Name |  |\n| --- | --- |\n| A | [IMPORTANT](https://example.test/x) |\n");
      expect(result).toEndWith("\n[Readable copy truncated at the file size limit.]\n");
      expect(Buffer.byteLength(result)).toBeLessThanOrEqual(1024);
      expect(stringify.mock.calls.length).toBeLessThan(60);
    } finally {
      stringify.mockRestore();
    }
    const html = "<table>" + "<tr><td>A</td></tr>".repeat(30) + "<tr>" + "<td>B</td>".repeat(100) + "</tr></table>";
    const result = await htmlToReadableMarkdown(new TextEncoder().encode(html), {
      baseUrl,
      maxBytes: 1024,
      maxInputBytes: Buffer.byteLength(html),
    });
    expect(result).toContain("[Readable copy truncated at the file size limit.]");
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(1024);
    const rows = result
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("|"));
    expect(rows).toHaveLength(32);
    expect(new Set(rows.map((line) => line.split("|").length)).size).toBe(1);
  });

  test("implicitly closes list items through paragraphs and inline frames", async () => {
    expect(await convert("<ul><li hidden><p>Hidden<li><p>Visible</ul>")).toBe("- Visible\n");
    expect(await convert("<ul><li><p>First<li><p>Second</ul>")).toBe("- First\n\n- Second\n");
    expect(await convert("<ul><li hidden><div><span>Hidden<li>Visible</ul>")).toBe("- Visible\n");
  });

  test("implicitly closes definition items through paragraphs and inline frames", async () => {
    expect(await convert("<dl><dt><p>Term<dd>Def</dl>")).toBe("Term\n\nDef\n");
    expect(await convert("<dl><dt hidden><p>Term<dd>Def</dl>")).toBe("Def\n");
    expect(await convert("<dl><dd hidden><span>Hidden<dt>Term<dd>Def</dl>")).toBe("Term\n\nDef\n");
  });

  test("implicitly closes paragraphs through inline frames before blocks and items", async () => {
    expect(await convert("<p>A<span>B<div>C</div></span>")).toBe("AB\n\nC\n");
    expect(await convert("<p hidden>A<span>B<div>C</div></span>")).toBe("C\n");
    for (const tag of ["li", "dd", "dt", "h1", "h2", "h3", "h4", "h5", "h6"]) {
      const prefix = tag === "li" ? "- " : tag.startsWith("h") ? `${"#".repeat(Number(tag[1]))} ` : "";
      expect(await convert(`<p hidden>A<span>B<${tag}>C</${tag}></span>`)).toBe(`${prefix}C\n`);
    }
  });

  test("respects special-element and button-scope boundaries and removes them on close", async () => {
    expect(await convert("<ul><li hidden><blockquote><p>Hidden<li>Still hidden</blockquote></li><li>Visible</ul>")).toBe("- Visible\n");
    expect(await convert("<ul><li hidden><blockquote></blockquote><p>Hidden<li>Visible</ul>")).toBe("- Visible\n");
    expect(await convert("<dl><dt hidden><li><p>Hidden<dd>Still hidden</li></dt><dd>Visible</dl>")).toBe("Visible\n");
    expect(await convert("<ul><li hidden><dd><p>Hidden<li>Still hidden</dd></li><li>Visible</ul>")).toBe("- Visible\n");
    expect(await convert("<p hidden><button><span><div>Hidden</div></span></button></p><p>Visible")).toBe("Visible\n");
    expect(await convert("<button></button><p hidden><span><div>Visible</div>")).toBe("Visible\n");
  });

  test.each([
    ["list items", "<ul>" + "<div>".repeat(100_000) + "</li><li>x".repeat(100_000), "- x\n".repeat(100_000)],
    ["paragraphs", "<p>" + "<span>".repeat(100_000) + "<div>y</div>".repeat(100_000), "y\n\n".repeat(99_999) + "y\n"],
  ])("balances implied %s closes at adversarial depth in linear time", async (_name, html, expected) => {
    const bytes = new TextEncoder().encode(html);
    expect(await htmlToReadableMarkdown(bytes, { baseUrl, maxBytes: 1024 * 1024, maxInputBytes: bytes.byteLength })).toBe(expected);
  });

  test("implicitly closes head before body elements or direct non-whitespace text", async () => {
    expect(await convert("<head><title>Title</title><main><p>Body</p></main>")).toBe("# Title\n\nBody\n");
    expect(await convert("<html><head><title>T</title>Hello <p>World</p>")).toBe("# T\n\nHello\n\nWorld\n");
    expect(await convert('<head> \n<title>T</title><meta charset="utf-8"><style>hidden</style><p>Body')).toBe("# T\n\nBody\n");
  });

  test("aligns data table columns across rowspans and colspans", async () => {
    expect(
      await convert(
        '<table><tr><th>Name</th><th>Value</th></tr><tr><td rowspan="2">A</td><td>10</td></tr><tr><td>20</td></tr><tr><td colspan="2">Total 30</td></tr></table>',
      ),
    ).toBe("| Name | Value |\n| --- | --- |\n| A | 10 |\n|  | 20 |\n| Total 30 |  |\n");
    expect(await convert('<table><tr></tr><tr><th colspan="2">A</th></tr></table>')).toBe("| A |  |\n| --- | --- |\n");
  });

  test("keeps zero rowspans within their table and aligns trailing reserved columns", async () => {
    expect(
      await convert(
        '<table><tr><th>X</th><th colspan="2" rowspan="0">A</th></tr><tr><td>B</td></tr><tr></tr></table><table><tr><td>C</td></tr></table>',
      ),
    ).toBe("| X | A |  |\n| --- | --- | --- |\n| B |  |  |\n|  |  |  |\n\n| C |\n| --- |\n");
  });

  test("closes either kind of table cell before the other opens", async () => {
    for (const cells of ["<td>A<th>B", "<th>A<td>B"]) {
      expect(await convert(`<table><tr>${cells}</tr></table>`)).toBe("| A | B |\n| --- | --- |\n");
    }
  });

  test("ends rowspan reservations at each row group boundary", async () => {
    for (const group of ["thead", "tbody", "tfoot"]) {
      for (const rowspan of ["0", "5"]) {
        expect(
          await convert(
            `<table><${group}><tr><td rowspan="${rowspan}">A</td><td>B</td></tr><tr><td>C</td></tr></${group}><tbody><tr><td>D</td><td>E</td></tr></tbody></table>`,
          ),
        ).toBe("| A | B |\n| --- | --- |\n|  | C |\n| D | E |\n");
      }
    }
    // Closing a group also ends spans before subsequent rows without an explicit group.
    expect(await convert('<table><tbody><tr><td rowspan="0">A</td></tr></tbody><tr><td>B</td></tr></table>')).toBe(
      "| A |\n| --- |\n| B |\n",
    );
    // An opening group also ends spans from preceding rows without an explicit group.
    expect(await convert('<table><tr><td rowspan="0">A</td></tr><tbody><tr><td>B</td></tr></tbody></table>')).toBe(
      "| A |\n| --- |\n| B |\n",
    );
  });

  test("indents list continuation paragraphs, nested lists and every line of fenced code", async () => {
    expect(await convert("<ul><li><p>First</p><p>Second</p></li></ul>")).toBe("- First\n\n  Second\n");
    expect(await convert('<ol start="10"><li>First<ul><li>Nested<p>Continuation</p></li></ul><p>Last</p></li></ol>')).toBe(
      "10. First\n    - Nested\n\n      Continuation\n\n    Last\n",
    );
    expect(await convert('<ul><li>First<pre class="language-js">one\n  two</pre><p>Last<br>line</p></li></ul>')).toBe(
      "- First\n\n  ```js\n  one\n    two\n  ```\n\n  Last\n  line\n",
    );
    expect(await convert("<ul><li><pre>one\ntwo</pre></li></ul>")).toBe("- ```\n  one\n  two\n  ```\n");
  });

  test("parses integer spans, defaults invalid values and clamps colspans", async () => {
    for (const value of ["invalid", "-2", "0"]) {
      expect(await convert(`<table><tr><td colspan="${value}">A</td><td>B</td></tr></table>`)).toBe("| A | B |\n| --- | --- |\n");
    }
    for (const value of ["invalid", "-2", "1"]) {
      expect(await convert(`<table><tr><td rowspan="${value}">A</td></tr><tr><td>B</td></tr></table>`)).toBe("| A |\n| --- |\n| B |\n");
    }
    expect(await convert('<table><tr><td colspan=" 2more">A</td></tr></table>')).toBe("| A |  |\n| --- | --- |\n");
    for (const value of ["1000", "1001", "999999999999999999999"]) {
      expect(await convert(`<table><tr><td colspan="${value}">A</td></tr></table>`)).toBe(
        `| A${" | ".repeat(999)} |\n| ${Array(1000).fill("---").join(" | ")} |\n`,
      );
    }
  });

  test("clamps rowspans to 65534 without allocating per spanned row", async () => {
    const result = await convert(
      '<table><tr><td rowspan="65535">A</td></tr>' + "<tr></tr>".repeat(65533) + "<tr><td>Last</td></tr></table>",
    );
    expect(result).toBe("| A |\n| --- |\n" + "|  |\n".repeat(65533) + "| Last |\n");
  });

  test.each([
    ["heading", "<h2>", "</h2>"],
    ["table cell", "<table><tr><td>", "</td></tr></table>"],
    ["caption", "<table><caption>", "</caption><tr><td>End</td></tr></table>"],
    ["link with images", '<a href="outer">', "</a>"],
  ])("bounds inline URL expansion inside a %s", async (_name, start, end) => {
    const original = URL.prototype.toString;
    const stringify = spyOn(URL.prototype, "toString").mockImplementation(function (this: URL) {
      return original.call(this);
    });
    try {
      for (const documentBase of [true, false]) {
        stringify.mockClear();
        const longBase = `https://example.test/${"x".repeat(2000)}/`;
        const content = _name === "link with images" ? '<img src="x" alt="é">' : '<a href="x">é</a>';
        const html = `${documentBase ? `<base href="${longBase}">` : ""}${start}${content.repeat(50_000)}${end}`;
        const result = await htmlToReadableMarkdown(new TextEncoder().encode(html), {
          baseUrl: documentBase ? baseUrl : new URL(longBase),
          maxBytes: 64 * 1024,
        });
        expect(result).toEndWith("\n[Readable copy truncated at the file size limit.]\n");
        expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(64 * 1024);
        expect(result).not.toContain("�");
        // Each URL costs about 2 KiB. Stop resolving links when that output budget is full,
        // even though thousands of links fit within the separately bounded input prefix.
        expect(stringify.mock.calls.length).toBeLessThan(100);
      }
    } finally {
      stringify.mockRestore();
    }
  });

  test("stops assembling a data row when its expanded cells fill the remaining budget", async () => {
    const stringify = spyOn(URL.prototype, "toString");
    try {
      const result = await convert(
        `<p>${"ü".repeat(1000)}</p><base href="https://example.test/${"x".repeat(2000)}/"><table><tr>${'<td colspan="1000"><a href="x">é</a></td>'.repeat(1000)}</tr></table>`,
        { maxBytes: 64 * 1024 },
      );
      expect(result).toStartWith("ü".repeat(1000));
      expect(result).toEndWith("\n[Readable copy truncated at the file size limit.]\n");
      expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(64 * 1024);
      expect(stringify.mock.calls.length).toBeLessThan(40);
    } finally {
      stringify.mockRestore();
    }
  });

  test("bundles htmlparser2 into the server output", async () => {
    const build = await Bun.build({
      entrypoints: [new URL("./readable-html.ts", import.meta.url).pathname],
      target: "bun",
    });
    expect(build.success).toBe(true);
    expect(build.outputs).toHaveLength(1);
    expect(await build.outputs[0]!.text()).not.toMatch(/["']htmlparser2["']/);
  });

  test("loads in the same process as sanitize-html, whichever module is imported first", () => {
    const emailHtml = new URL("../shared/email-html.ts", import.meta.url).pathname;
    const readableHtml = new URL("./readable-html.ts", import.meta.url).pathname;
    for (const [first, second] of [
      [emailHtml, readableHtml],
      [readableHtml, emailHtml],
    ]) {
      const run = Bun.spawnSync([process.execPath, "-e", `import ${JSON.stringify(first)}; import ${JSON.stringify(second)};`], {
        stderr: "pipe",
      });
      expect(run.stderr.toString()).not.toContain("require() async module");
      expect(run.exitCode).toBe(0);
    }
  });

  test("extracts an article and renders readable Markdown without page chrome or executable content", async () => {
    const result = await convert(`<!doctype html><html><head><title> A &amp; B </title><meta name="description" content="META">
      <script>HEAD_SCRIPT</script><style>HEAD_STYLE</style></head><body>
      <header>SITE_HEADER</header><nav>NAVIGATION</nav><aside>ASIDE</aside>
      <div id="cookie-banner">COOKIE<div>COOKIE_CHILD</div></div>
      <article><header><h1>A &amp; B</h1><p>Article header</p></header>
      <h2> A subtitle </h2><p>First <b>paragraph</b> &amp; entities.</p>
      <ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul><ol start="3"><li>Three</li><li>Four</li></ol>
      <p><a href="../x">Relative</a> <a href="/y">Root</a> <a href="//cdn.example.test/z">CDN</a></p>
      <table><tr><th>A</th><th>B</th></tr><tr><td>one | two</td><td><p>three</p><p>four</p></td></tr></table>
      <pre><code class="language-ts">const x = 1;\n  console.log(x);</code></pre>
      <script>BODY_SCRIPT</script><style>BODY_STYLE</style><noscript>NOSCRIPT</noscript>
      </article><footer>FOOTER</footer></body></html>`);
    expect(result).toStartWith("# A & B\n\nArticle header\n");
    expect(result).not.toContain("# A & B\n\n# A & B");
    for (const snippet of [
      "## A subtitle",
      "First paragraph & entities.",
      "- One\n- Two\n  - Nested",
      "3. Three\n4. Four",
      "[Relative](https://example.test/articles/x)",
      "[Root](https://example.test/y)",
      "[CDN](https://cdn.example.test/z)",
      "A\n\nB\n\none | two\n\nthree\n\nfour",
      "```ts\nconst x = 1;\n  console.log(x);\n```",
    ])
      expect(result).toContain(snippet);
    for (const forbidden of [
      "META",
      "HEAD_SCRIPT",
      "HEAD_STYLE",
      "BODY_SCRIPT",
      "BODY_STYLE",
      "NOSCRIPT",
      "NAVIGATION",
      "SITE_HEADER",
      "FOOTER",
      "ASIDE",
      "COOKIE",
    ])
      expect(result).not.toContain(forbidden);
    expect(result).toEndWith("\n");
  });

  test("prefers the first outermost main, falls back to all articles, then body", async () => {
    expect(await convert("outside<article>Article</article><main>Main<main>Nested</main></main><main>Later</main>after")).toBe(
      "Main\n\nNested\n",
    );
    expect(await convert("chrome<article>First</article><div>between</div><article>Last</article>end")).toBe("First\n\nbetween\n\nLast\n");
    expect(await convert("<main> </main><article>Fallback</article>chrome")).toBe("Fallback\n");
    expect(await convert("before<body><div>Body</div><p>paragraph</p></body>after")).toBe("before\n\nBody\n\nparagraph\n\nafter\n");
  });

  test("keeps content h1 headings and omits the page title whenever the selected content has one", async () => {
    expect(
      await convert(
        "<head><title> My TITLE </title></head><article><header><h1>my\n title</h1></header><p>Text</p><h1>My TITLE</h1></article>",
      ),
    ).toBe("# my title\n\nText\n\n# My TITLE\n");
    expect(await convert("<article><header><h1>Article title</h1></header>Text</article>")).toBe("# Article title\n\nText\n");
    expect(await convert("<title>Markdown - Wikipedia</title><main><h1>Markdown</h1><p>Text</p></main>")).toBe("# Markdown\n\nText\n");
    expect(await convert("<title>Page title</title><h1>Outside</h1><main><h2>Section</h2><p>Text</p></main>")).toBe(
      "# Page title\n\n## Section\n\nText\n",
    );
    expect(
      await convert('<title>Fallback</title><main><h1 hidden>Hidden</h1><h1> </h1><h1><a href="#h">#</a></h1><p>Text</p></main>'),
    ).toBe("# Fallback\n\nText\n");
    expect(await convert('<title>Page title</title><main><h1><img src="/p.png" alt="Picture"></h1></main>')).toBe(
      "# ![Picture](https://example.test/p.png)\n",
    );
    expect(await convert("<title>Page title</title><main><pre><h1>Code</h1></pre><p>Text</p></main>")).toBe(
      "# Page title\n\n```\nCode\n```\n\nText\n",
    );
    expect(await convert("<title>Title</title><h1>Title</h1>")).toBe("# Title\n");
    expect(await convert("<title>Title</title><h1><b><h1> </h1>Content</b></h1>")).toBe("# Content\n");
    expect(await convert('<title>Fallback</title><h1><code><img src="/p.png" alt="Ignored"></code></h1><p>Text</p>')).toBe(
      "# Fallback\n\nText\n",
    );
  });

  test("skips hidden subtrees, roles, banners and media without desynchronizing void or implied closes", async () => {
    const html = `<main><p hidden>HIDDEN<p>visible<input hidden><p aria-hidden="true">ARIA</p>
      <div role="navigation">ROLE</div><div class="cmp-overlay">CMP</div><div class="some-cookie-consent-box">COOKIE</div>
      <div class="${"x".repeat(200)}">long class</div>
      <template>TEMPLATE</template><svg><text>SVG</text></svg><math>MATH</math><iframe>IFRAME</iframe><object>OBJECT</object>
      <embed>after embed<canvas>CANVAS</canvas><video>VIDEO</video><audio>AUDIO</audio><form>FORM<button>BUTTON</button></form>
      <select><option>SELECT</option></select><textarea>TEXTAREA</textarea><dialog>DIALOG</dialog><footer>article-free footer</footer></main>`;
    const result = await convert(html);
    expect(result).toContain("visible");
    expect(result).toContain("long class");
    expect(result).toContain("after embed");
    expect(result).toContain("article-free footer");
    for (const value of [
      "HIDDEN",
      "ARIA",
      "ROLE",
      "CMP",
      "COOKIE",
      "TEMPLATE",
      "SVG",
      "MATH",
      "IFRAME",
      "OBJECT",
      "CANVAS",
      "VIDEO",
      "AUDIO",
      "FORM",
      "BUTTON",
      "SELECT",
      "TEXTAREA",
      "DIALOG",
    ])
      expect(result).not.toContain(value);
  });

  test("handles unclosed tags, stray end tags, and unclosed scripts", async () => {
    expect(await convert("</div></nav><article><p>Good<p>Still good<script>SECRET <p>LEAK")).toBe("Good\n\nStill good\n");
    expect(await convert("<nav><img src=x><br>NO</nav><p>Yes")).toBe("Yes\n");
    expect(await convert("<script/>SECRET<script>LEAK")).toBe("");
    expect(await convert("<style/>SECRET</style><p>Yes</p>")).toBe("Yes\n");
  });

  test("balances self-closing dropped tags and article spans crossing ancestor boundaries", async () => {
    expect(await convert("<svg/><input hidden/><article>First</article><article>Last</article>")).toBe("First\n\nLast\n");
    expect(await convert("<blockquote><article>First</article></blockquote><article>Last</article>")).toBe("First\n\nLast\n");
    expect(await convert("<table><tr><td><article>First</article></td></tr></table><article>Last</article>")).toContain("Last");
  });

  test("closes XHTML non-void elements immediately without closing void elements twice", async () => {
    const html = '<p>Before</p><script src="/app.js" /><p>After</p>';
    for (const contentType of ["application/xhtml+xml", " Application/XHTML+XML ; charset=utf-8"]) {
      expect(await convert(html, { contentType })).toBe("Before\n\nAfter\n");
      expect(await convert('<p>Before<div/>After <a href="x"/>outside<br/>next</p>', { contentType })).toBe(
        "Before\n\nAfter outside\nnext\n",
      );
    }
    expect(await convert(html, { contentType: "text/html; charset=utf-8" })).toBe("Before\n");
  });

  test("renders inline links, code and images in headings and table cells", async () => {
    const result = await convert(
      '<title>Title</title><h1>Ti<b>tle</b></h1><h2><a href="/guide">A [guide]</a> <code>x``y</code></h2><table><tr><td><a href="/source">Source</a></td><td><code>a</code><img alt="pic" src="/pic.png"></td></tr></table>',
    );
    expect(result).not.toContain("\n# Title");
    expect(result).toContain("## [A \\[guide\\]](https://example.test/guide) ```x``y```");
    expect(result).toContain("| [Source](https://example.test/source) | `a`![pic](https://example.test/pic.png) |");
  });

  test("returns empty for an empty body, only scripts, or a title alone", async () => {
    for (const html of [
      "",
      "<body> </body>",
      "<title>Title</title><body></body>",
      "<script>secret</script>",
      "<title>Title</title><script>secret</script>",
    ])
      expect(await convert(html)).toBe("");
  });

  test("filters unsafe and same-page fragment links and renders escaped labels and images", async () => {
    const result = await convert(`<p><a href="javascript:alert(1)">safe text</a> <a href="data:text/html,x">data</a>
      <a href="#here">here</a> <a href="mailto:a@example.test">Mail</a> <a href="/a(b) c">[label]</a>
      <a href="/empty"></a><img alt=" A [picture] " src="//cdn.example.test/a.png"><img alt="" src="/no"><img alt="bad" src="javascript:x"></p>`);
    expect(result).toContain("safe text data here [Mail](mailto:a@example.test)");
    expect(result).toContain("[\\[label\\]](https://example.test/a%28b%29%20c)");
    expect(result).toContain("![A \\[picture\\]](https://cdn.example.test/a.png)");
    for (const value of ["javascript:", "data:text", "/empty", "/no", "bad"]) expect(result).not.toContain(value);
  });

  test("uses the first base href, including in the skipped head, for links and images", async () => {
    expect(await convert('<head><base href="https://cdn.example.org/docs/"></head><body><a href="guide.html">Guide</a></body>')).toBe(
      "[Guide](https://cdn.example.org/docs/guide.html)\n",
    );
    expect(
      await convert(
        '<head><base target="_blank"><base href="../assets/"><base href="https://ignored.test/"></head><h1><a href="guide.html">Guide</a></h1><p><img src="pic.png" alt="Picture"></p><table><tr><td><a href="data.html">Data</a></td></tr></table>',
      ),
    ).toBe(
      "# [Guide](https://example.test/articles/assets/guide.html)\n\n![Picture](https://example.test/articles/assets/pic.png)\n\n| [Data](https://example.test/articles/assets/data.html) |\n| --- |\n",
    );
  });

  test("ignores unsafe or invalid base hrefs without accepting a later base", async () => {
    for (const href of ["javascript:alert(1)", "http://[", "mailto:a@example.test"]) {
      expect(
        await convert(
          `<head><base href="${href}"><base href="https://ignored.test/"></head><p><a href="guide.html">Guide</a><img src="pic.png" alt="Picture"></p>`,
        ),
      ).toBe("[Guide](https://example.test/articles/2026/guide.html)![Picture](https://example.test/articles/2026/pic.png)\n");
    }
  });

  test("trims link labels and preserves whitespace as an outer word separator", async () => {
    expect(await convert("<p>Before<a href=x> Learn more </a>after</p>")).toBe(
      "Before [Learn more](https://example.test/articles/2026/x) after\n",
    );
    expect(await convert("<h2>Before<a href=x> <b>Learn</b> more </a>after</h2>")).toBe(
      "## Before [Learn more](https://example.test/articles/2026/x) after\n",
    );
    expect(await convert("<table><tr><td>Before<a href=x> Learn more </a>after</td></tr></table>")).toBe(
      "| Before [Learn more](https://example.test/articles/2026/x) after |\n| --- |\n",
    );
  });

  test("omits short symbolic fragment permalinks while retaining other fragment labels", async () => {
    for (const symbol of ["#", "¶", "§", "🔗", "#¶", "🔗🔗"]) {
      expect(await convert(`<h2>Run tests<a href="#run-tests"> ${symbol} </a></h2>`)).toBe("## Run tests\n");
      expect(await convert(`<p>Before<a href="#here"><b>${symbol}</b></a>after</p>`)).toBe("Beforeafter\n");
    }
    for (const label of ["A", "é", "字", "1", "١", "###", "Read more"]) {
      expect(await convert(`<h2>See <a href="#here">${label}</a></h2>`)).toBe(`## See ${label}\n`);
    }
    expect(await convert('<h2>Run<a href="/run">#</a></h2>')).toBe("## Run[#](https://example.test/run)\n");
    expect(await convert('<p>Before <a href="#here">#</a>after</p>')).toBe("Before after\n");
    expect(await convert('<title>Fallback</title><h1><a href="#here">Read more</a></h1>')).toBe("# Read more\n");
    expect(await convert('<p><a href="#here">[More]</a></p>')).toBe("[More]\n");
  });

  test("renders layout table cells as normal blocks including lists, headings and links", async () => {
    expect(
      await convert(
        '<title>Site</title><table><tr><td><p>First</p><p>Second</p></td><td><h1>Links</h1><ul><li><a href="/x">Item</a></li><li>Next</li></ul></td></tr></table>',
      ),
    ).toBe("First\n\nSecond\n\n# Links\n\n- [Item](https://example.test/x)\n- Next\n");
  });

  test("renders data tables within layout tables and keeps adjacent data tables independent", async () => {
    const data = "<table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>one | two</td></tr></table>";
    const markdown = "| Name | Value |\n| --- | --- |\n| A | one \\| two |";
    expect(await convert(data)).toBe(`${markdown}\n`);
    expect(await convert(`<table><tr><td><p>Before</p>${data}<p>After</p></td><td>${data}</td></tr></table>`)).toBe(
      `Before\n\n${markdown}\n\nAfter\n\n${markdown}\n`,
    );
  });

  test("renders data table captions as inline Markdown paragraphs before the rows", async () => {
    expect(
      await convert(
        '<p>Before</p><table><caption> All amounts\n in <code>thousands</code> of <a href="/eur">EUR</a> </caption><tr><th>Year</th><th>Amount</th></tr><tr><td>2026</td><td>42</td></tr></table><p>After</p>',
      ),
    ).toBe(
      "Before\n\nAll amounts in `thousands` of [EUR](https://example.test/eur)\n\n| Year | Amount |\n| --- | --- |\n| 2026 | 42 |\n\nAfter\n",
    );
    expect(
      await convert(
        "<table><caption>All amounts in thousands of EUR</caption><tr><td>42</td></tr></table><table><tr><td>Next</td></tr></table>",
      ),
    ).toBe("All amounts in thousands of EUR\n\n| 42 |\n| --- |\n\n| Next |\n| --- |\n");
    expect(
      await convert("<table><caption>All amounts in thousands of EUR</caption><tr><td><p>First</p><p>Second</p></td></tr></table>"),
    ).toBe("All amounts in thousands of EUR\n\nFirst\n\nSecond\n");
  });

  test("keeps explicit line breaks and does not attach an empty list marker to later text", async () => {
    expect(await convert("<p>one<br>two<br><br>three</p>")).toBe("one\ntwo\n\nthree\n");
    expect(await convert("<ul><li></li></ul><p>outside</p>")).toBe("outside\n");
    expect(await convert("<ul><li><ul><li></li></ul>outer</li></ul>")).toBe("- outer\n");
  });

  test("uses sufficiently long code fences, preserves nested data tables and caps blockquote prefixes", async () => {
    const result = await convert(
      '<p><code>a``b</code></p><pre class="lang-js">a```b\n  c</pre><blockquote><p>quote<br>next</p></blockquote><table><tr><td>A<table><tr><td>B</td></tr></table>C</td></tr></table>',
    );
    expect(result).toContain("```a``b```");
    expect(result).toContain("````js\na```b\n  c\n````");
    expect(result).toContain("> quote\n> next");
    expect(result).toContain("A\n\n| B |\n| --- |\n\nC");
  });

  test("ends omitted table parts at a new row group and keeps spaces around inline code", async () => {
    expect(await convert("<table><tbody><tr><td>One<tbody><tr><td>Two</table>")).toBe("| One |\n| --- |\n| Two |\n");
    expect(await convert("<table><tr><td>A<span>B<tr><td>C</table>")).toBe("| AB |\n| --- |\n| C |\n");
    expect(await convert("<p>Run<code> npm </code>now</p>")).toBe("Run `npm` now\n");
    expect(await convert("<p><code>a</code><code>b</code></p>")).toBe("`a` `b`\n");
    expect(await convert('<p><a href="/api"><code>items[0]</code> [all]</a></p>')).toBe(
      "[`items[0]` \\[all\\]](https://example.test/api)\n",
    );
    expect(await convert("<h2><code>a</code><code>b</code></h2>")).toBe("## `a` `b`\n");
  });

  test("keeps head templates inert and line breaks inside preformatted code", async () => {
    expect(await convert("<head><template><main>INERT</main></template></head><body><main>Actual article</main></body>")).toBe(
      "Actual article\n",
    );
    expect(
      await convert(
        '<head><template><base href="https://wrong.test/"></template><base href="https://right.test/"></head><p><a href="guide">Guide</a></p>',
      ),
    ).toBe("[Guide](https://right.test/guide)\n");
    expect(await convert("<pre><code>npm install<br>npm test</code></pre>")).toBe("```\nnpm install\nnpm test\n```\n");
  });

  test("lets a byte order mark win over header and meta charsets", async () => {
    const html = '<meta charset="windows-1252"><p>Grüße äöü</p>';
    const utf16 = (littleEndian: boolean) => {
      const bytes = new Uint8Array(2 + html.length * 2);
      const view = new DataView(bytes.buffer);
      view.setUint16(0, 0xfeff, littleEndian);
      for (let index = 0; index < html.length; index++) view.setUint16(2 + index * 2, html.charCodeAt(index), littleEndian);
      return bytes;
    };
    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(html)]);
    for (const bytes of [utf8, utf16(true), utf16(false)]) {
      expect(await htmlToReadableMarkdown(bytes, { baseUrl, maxBytes: 4096, contentType: "text/html; charset=ISO-8859-1" })).toBe(
        "Grüße äöü\n",
      );
    }
  });

  test("decodes header and meta charsets, prioritizes headers, and falls back for unsupported labels", async () => {
    const latin = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
    for (const html of [
      "<p>Grüße äöü</p>",
      '<meta charset="ISO-8859-1"><p>Grüße äöü</p>',
      '<meta http-equiv="content-type" content="text/html; charset=windows-1252"><p>Grüße äöü</p>',
    ]) {
      expect(
        await htmlToReadableMarkdown(latin(html), {
          baseUrl,
          maxBytes: 4096,
          contentType: html.startsWith("<p>") ? 'text/html; charset="windows-1252"' : undefined,
        }),
      ).toBe("Grüße äöü\n");
    }
    expect(
      await htmlToReadableMarkdown(latin('<meta charset="utf-8"><p>ä</p>'), {
        baseUrl,
        maxBytes: 4096,
        contentType: "text/html; charset=ISO-8859-1",
      }),
    ).toBe("ä\n");
    expect(
      await htmlToReadableMarkdown(new TextEncoder().encode("<p>ü</p>"), {
        baseUrl,
        maxBytes: 4096,
        contentType: "text/html; charset=unsupported",
      }),
    ).toBe("ü\n");
  });

  test("bounds output with deeply nested blocks, lists, blockquotes and layout tables", async () => {
    expect(await convert("<div>".repeat(50_000) + "text" + "</div>".repeat(50_000))).toBe("text\n");
    const lists = await convert("<ul><li>".repeat(20_000) + "text" + "</li></ul>".repeat(20_000));
    expect(lists.length).toBeLessThan(40);
    expect(lists).toContain("text");
    const quotes = await convert("<blockquote>".repeat(20_000) + "text" + "</blockquote>".repeat(20_000));
    expect(quotes.length).toBeLessThan(40);
    const tables = await convert("<table><tr><td>".repeat(20_000) + "text" + "</td></tr></table>".repeat(20_000));
    expect(tables).toBe("| text |\n| --- |\n");
  }, 10_000);

  test.each(["<p>Kept</p>", "<main><h1>Kept"])(
    "finishes retained frames when the parser state budget is exhausted after %s",
    async (prefix) => {
      const html = prefix + "<i>".repeat(600_000) + "<p>Beyond budget</p>";
      const result = await htmlToReadableMarkdown(new TextEncoder().encode(html), {
        baseUrl,
        maxBytes: 1024 * 1024,
        maxInputBytes: 20 * 1024 * 1024,
      });
      expect(result).toBe(`${prefix.includes("<h1>") ? "# " : ""}Kept\n\n[Readable copy truncated at the file size limit.]\n`);
    },
  );

  test.each(["<i>x", "<span>x</span>"])(
    "bounds retained state for a flood of %s",
    async (tag) => {
      const result = await htmlToReadableMarkdown(new TextEncoder().encode(tag.repeat(3_000_000)), {
        baseUrl,
        maxBytes: 1024 * 1024,
        maxInputBytes: 20 * 1024 * 1024,
      });
      expect(result).toStartWith("x".repeat(100));
      expect(result).toEndWith("\n[Readable copy truncated at the file size limit.]\n");
      // State, rather than the 1 MiB output cap, must stop these tag-dense inputs.
      expect(Buffer.byteLength(result)).toBeLessThan(600_000);
    },
    10_000,
  );

  test.each(["<i>x", "<span>x</span>"])("retains text without spending event pairs on %s", async (tag) => {
    const result = await htmlToReadableMarkdown(new TextEncoder().encode(tag.repeat(200_000)), {
      baseUrl,
      maxBytes: 1024 * 1024,
      maxInputBytes: 20 * 1024 * 1024,
    });
    expect(result).toBe("x".repeat(200_000) + "\n");
  });

  test("skips formatting events consistently inside every renderer capture", async () => {
    const format = (text: string) => `<span class="${"x".repeat(200)}"><i><custom-tag>${text}</custom-tag></i></span>`;
    expect(
      await convert(
        `<h1>${format("Heading")}</h1><p><a href="x">${format("Link")}</a> <code>${format("Code")}</code></p><pre>${format("Pre")}</pre><table><tr><td>${format("Cell")}</td></tr></table>`,
      ),
    ).toBe("# Heading\n\n[Link](https://example.test/articles/2026/x) `Code`\n\n```\nPre\n```\n\n| Cell |\n| --- |\n");
    expect(await convert("<p>Before<span hidden><b>Hidden</b></span>After</p>")).toBe("BeforeAfter\n");
  });

  test("clips UTF-8 output and input at the byte limit and appends the truncation notice", async () => {
    const result = await convert("<p>" + "ü".repeat(200) + "</p>", { maxBytes: 100 });
    expect(result).toEndWith("\n[Readable copy truncated at the file size limit.]\n");
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(100);
    expect(result).not.toContain("�");
    const prefix = "<p>hello</p>";
    expect(await convert(prefix + "secret".repeat(100), { maxBytes: prefix.length })).not.toContain("secret");
  });

  test("caps Markdown expansion even when the complete HTML fits the input limit", async () => {
    const html = '<a href="/x">link</a>'.repeat(6);
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(128);
    const result = await convert(html, { maxBytes: 128 });
    expect(result).toContain("[Readable copy truncated at the file size limit.]");
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(128);
  });

  test("counts code backticks across parser chunks", async () => {
    const result = await convert("<pre>" + "x".repeat(256 * 1024 - 7) + "````y</pre>");
    expect(result).toStartWith("`````\n");
    expect(result).toEndWith("````y\n`````\n");
  });

  test("shares the work budget across short headings, links and cells without yielding per call", async () => {
    let yielded = false;
    const immediate = setImmediate(() => {
      yielded = true;
    });
    try {
      await convert("<h2><a href=x>Heading</a></h2><table><tr><td><a href=x>Cell</a></td></tr></table>".repeat(8));
      expect(yielded).toBe(false);
      // The input fits in one parse chunk. Rendering must still yield as many
      // individually small inline spans exhaust the shared event budget.
      const html = "<a href=x>Link</a>".repeat(8000);
      expect(Buffer.byteLength(html)).toBeLessThan(256 * 1024);
      const controller = new AbortController();
      const abort = setImmediate(() => controller.abort(new Error("during render")));
      try {
        await expect(convert(html, { signal: controller.signal })).rejects.toThrow("during render");
      } finally {
        clearImmediate(abort);
      }
      expect(yielded).toBe(true);
    } finally {
      clearImmediate(immediate);
    }
  });

  test("streams decoding across chunks, yields and rejects when aborted", async () => {
    const html = "<p>" + "x".repeat(256 * 1024 - 4) + "ü</p>";
    let yielded = false;
    setImmediate(() => {
      yielded = true;
    });
    expect(await convert(html)).toContain("ü");
    expect(yielded).toBe(true);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(convert("<p>hello</p>", { signal: controller.signal })).rejects.toThrow("cancelled");
    const during = new AbortController();
    setImmediate(() => during.abort(new Error("during conversion")));
    await expect(convert(html, { signal: during.signal })).rejects.toThrow("during conversion");
  });
});
