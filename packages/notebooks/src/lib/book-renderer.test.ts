import { describe, expect, test } from "bun:test";
import type { NoteQueryResult } from "../service/note-query";
import { renderNotebookBook } from "./book-renderer";
import { bookRendererMessages } from "./book-renderer-messages";

const render = (markdown: string, locale = "en", queryResults?: ReadonlyMap<number, NoteQueryResult>) =>
  renderNotebookBook({ markdown, notebookId: "ABC123", locale, queryResults });

const result: NoteQueryResult = {
  columns: ["$title"],
  items: [
    {
      id: "DEF456",
      title: "Handbook",
      href: "/app/notebooks/ABC123/notes/DEF456",
      values: { $title: "Handbook", $tags: ["Team/News"], "profile.owner": "Ada", $created: "2026-09-01T10:00:00Z" },
    },
  ],
  total: 3,
  limit: 1,
  truncated: true,
  diagnostics: [],
};

describe("Notebook Book HTML", () => {
  test("renders standard Markdown and stable collision-free heading anchors", () => {
    const md = "# Handbook\n\n## Hello\n\n**bold** *italic* ~~old~~ `code`\n\n## Hello\n\n## Hello 2\n\n> Quote\n\n- one\n- two\n\n---";
    const first = render(md);
    expect(first.html).toContain("<strong>bold</strong>");
    expect(first.html).toContain("<em>italic</em>");
    expect(first.html).toContain("<del>old</del>");
    expect(first.html).toContain("<blockquote>");
    expect(new Set(first.headings.map((heading) => heading.id)).size).toBe(4);
    expect(first.headings.map((heading) => heading.id)).toEqual([
      "heading-handbook",
      "heading-hello",
      "heading-hello-2",
      "heading-hello-2-2",
    ]);
    expect(render(md)).toEqual(first);
  });

  test("TOC sees following headings and respects min/max depth", () => {
    const { html } = render(":::toc\nmin-depth: 2\nmax-depth: 2\n:::\n\n# Intro\n\n## Second\n\n### Third");
    expect(html).toContain('class="notebook-book-toc"');
    expect(html).toContain('href="#heading-second"');
    expect(html).not.toContain('href="#heading-intro"');
    expect(html).not.toContain('href="#heading-third"');
    expect(html).not.toContain("data-book-toc");
  });

  test("empty and malformed TOCs remain visible and localized", () => {
    expect(render(":::toc\n:::", "de").html).toContain("Keine Überschriften");
    expect(render(":::toc\nmax-depth: 9\n:::", "de").html).toContain("Ungültiger Block");
  });

  test("queries use list by default and preserve Book navigation", () => {
    const { html } = render(":::query\nsource: notes\n:::", "en", new Map([[1, result]]));
    expect(html).toContain("<ul>");
    expect(html).not.toContain("<table");
    expect(html).toContain('href="/app/notebooks/ABC123/notes/DEF456?mode=book"');
    expect(html).toContain("Showing 1 of 3 notes.");
  });

  test("queries use selected table columns without evaluating property contents", () => {
    const md = ":::query\nsource: notes\ncolumns:\n  - $title\n  - profile.owner\n  - $tags\n  - $created\n:::";
    const { html } = render(md, "de", new Map([[1, result]]));
    expect(html).toContain('<th scope="col">Titel</th>');
    expect(html).toContain("profile.owner");
    expect(html).toContain("<td>Ada</td>");
    expect(html).toContain("/tags/team%2Fnews?mode=book");
    expect(html).toContain('<time datetime="2026-09-01T10:00:00Z">');
    expect(html).toContain("1 von 3 Notizen");
  });

  test("query failures do not leak result contents and empty is distinct", () => {
    const md = ":::query\nsource: notes\n:::";
    expect(render(md).html).toContain("unavailable");
    expect(render(md, "en", new Map([[1, { ...result, diagnostics: [{ code: "unavailable" }] }]])).html).not.toContain("Handbook");
    expect(render(md, "en", new Map([[1, { ...result, items: [], total: 0 }]])).html).toContain("No matching notes");
    expect(render(":::query\nsource: secrets\n:::").html).toContain("Invalid block");
  });

  test("separate identical query directives keep their own line-keyed results", () => {
    const md = ":::query\nsource: notes\n:::\n\n:::query\nsource: notes\n:::";
    const { html } = render(
      md,
      "en",
      new Map([
        [1, result],
        [5, { ...result, items: [] }],
      ]),
    );
    expect(html).toContain("Handbook");
    expect(html).toContain("No matching notes");
  });

  test("typed data, named sections and notices retain notebook presentation", () => {
    const md =
      "@profile\n:::data\nowner: Ada\nactive: true\ncount: 3\nroles:\n  - Team\n  - false\n:::\n\n@process\n## Process\n\n:::warning\n**Read** [this](note://DEF456)\n:::";
    const { html } = render(md, "de");
    expect(html).toContain('id="block-profile"');
    expect(html).toContain("md-data-grid");
    expect(html).toContain("md-data-chip");
    expect(html).toContain('id="block-process"');
    expect(html).toContain('data-tone="warning"');
    expect(html).toContain("Warnung");
    expect(html).toContain("<strong>Read</strong>");
    expect(html).not.toContain("scripts");
  });

  test("invalid and unclosed data is not silently discarded", () => {
    expect(render(":::data\nbroken\n:::").html).toContain("Invalid block");
    const { html } = render(":::data\nkey: value");
    expect(html).toContain("Invalid block");
    expect(html).toContain("key: value");
  });

  test("tables use the existing formula engine and progress semantics", () => {
    const { html } = render("| Item | Value | Twice |\n| --- | ---: | ---: |\n| A | 2 | =Value*2 |\n| B | 3 | =Value*2 |");
    expect(html).toContain('class="md-table"');
    expect(html).toContain("md-formula-ok");
    expect(html).toContain("</i>4</span>");
    expect(html).toContain("</i>6</span>");
  });

  test("formula values and table links remain escaped and use Book URLs", () => {
    const { html } = render("| Link | Tag |\n| --- | --- |\n| [Note](note://DEF456) | #team |");
    expect(html).toContain("/notes/DEF456?mode=book");
    expect(html).toContain("/tags/team?mode=book");
  });

  test("note links, attachment links and sized images resolve to scoped endpoints", () => {
    const { html } = render(
      "[Note](note://DEF456) [File](attach://GHI789)\n\n![Photo](attach://GHI789 =320x200)\n\n![remote](https://example.test/a.png)",
    );
    expect(html).toContain("/notes/DEF456?mode=book");
    expect(html).toContain("/api/notebooks/ABC123/attachments/GHI789/content?v=1");
    expect(html).toContain('width="320" height="200"');
    expect(html).toContain('loading="lazy"');
  });

  test("tags are links outside code and link labels", () => {
    const { html } = render("#team/News `#code` [#label](https://example.test)");
    expect(html).toContain("/tags/team%2Fnews?mode=book");
    expect(html).not.toContain("/tags/code");
    expect(html).not.toContain("/tags/label");
  });

  test("inline decorations and all existing math forms render without a DOM", () => {
    const { html } = render("==marked== H~2~O x^2^ $x^2$ \\(x+1\\)\n\n$$\\frac{1}{2}$$\n\n\\[x^2\\]\n\n```math\n\\sqrt{2}\n```");
    expect(html).toContain("<mark>marked</mark>");
    expect(html).toContain("<sub>2</sub>");
    expect(html).toContain("<sup>2</sup>");
    expect(html.match(/class="notebook-book-math"/g)?.length).toBe(5);
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("NOTEBOOKBOOKSLOT");
  });

  test("script fences stay inert, highlighted source and do not produce executable carriers", () => {
    const { html, headings } = render("```script\nfetch('/secret');\n# Hidden\n:::query\nsource: notes\n:::\n```");
    expect(html).toContain("language-script");
    expect(html).toContain("fetch");
    expect(html).not.toContain("data-script");
    expect(html).not.toContain("notebook-book-query");
    expect(headings).toEqual([]);
  });

  test("Mermaid has escaped readable source with no script execution", () => {
    const { html } = render("```mermaid\nflowchart TD\n A[<script>alert(1)</script>]-->B\n```");
    expect(html).toContain("notebook-book-mermaid");
    expect(html).toContain("flowchart TD");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("display:none");
  });

  test("raw HTML and dangerous URLs cannot create executable DOM", () => {
    const md =
      '<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>\n\n[evil](javascript:alert) [evil](//evil.test) ![evil](data:image/svg+xml;base64,xxx)\n\n[evil](java&#x73;cript:alert) [evil](\\\\evil.test)';
    const { html } = render(md);
    expect(html).not.toMatch(/<(?:script|iframe)\b/i);
    expect(html).not.toMatch(/<(?:img|a)\b[^>]*(?:onerror|javascript:|data:|href="\/\/)/i);
    expect(html).toContain("&lt;script&gt;");
  });

  test("authored markers cannot replace generated output", () => {
    const { html } = render("NOTEBOOKBOOKSLOTMATH0END\n\n$x$");
    expect(html).toContain("NOTEBOOKBOOKSLOTMATH0END");
    expect(html.match(/class="katex"/g)?.length).toBe(1);
  });

  test("task checkboxes are always disabled in Book", () => {
    const { html } = render("- [x] Done\n- [ ] Todo");
    expect(html.match(/disabled/g)?.length).toBe(2);
    expect(html.match(/checked/g)?.length).toBe(1);
  });

  test("renderer catalog has complete German localization", () => {
    expect(bookRendererMessages.check()).toEqual([]);
  });

  test("TOC labels handle entities and math without leaking generated markers", () => {
    const md = ":::toc\n:::\n\n## A & B $x$";
    const first = render(md);
    expect(first.headings[0]?.text).toBe("A & B x");
    expect(first.html).not.toContain("NOTEBOOKBOOKSLOT");
    expect(first.html).not.toContain("&amp;amp;");
    expect(render(md)).toEqual(first);
  });

  test("math cannot opt into trusted HTML or URL commands", () => {
    const { html } = render("$\\href{javascript:alert(1)}{click}$ $\\htmlClass{evil}{text}$");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('class="evil"');
  });

  test("named blocks with repeated handles do not create duplicate anchor IDs", () => {
    const { html } = render("@part\n## First\n\n@part\n## Second");
    expect(html).toContain('id="block-part"');
    expect(html).toContain('id="block-part-2"');
  });
});
