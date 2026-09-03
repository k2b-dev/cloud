import { describe, expect, test } from "bun:test";
import { renderNotebookBook } from "../lib/book-renderer";
import { extractNamedDataProperties } from "../lib/named-blocks";
import { parseNotebookQueryBlocks, parseNotebookTocBlocks } from "../lib/query-blocks";
import { notebookHelp } from ".";

const expectedIds = [
  "notebooks-start",
  "notebooks-core-model",
  "notebooks-write-organize",
  "notebooks-structured-blocks",
  "notebooks-table-formulas",
  "notebooks-settings-access",
  "notebooks-troubleshooting",
];
const document = (id: string) => notebookHelp.documents.find((candidate) => candidate.id === id)!;

describe("notebookHelp", () => {
  test("keeps the reviewed topic order explicit", () => {
    expect(notebookHelp.documents.map((document) => document.id)).toEqual(expectedIds);
    for (const id of expectedIds) expect(notebookHelp.getMarkdown(id)?.length).toBeGreaterThan(20);
  });

  test("translates every topic and resolves regional locale fallbacks", () => {
    const english = notebookHelp.documentsByLocale?.en ?? [];
    const german = notebookHelp.documentsByLocale?.de ?? [];
    expect(german.map((document) => document.id)).toEqual(english.map((document) => document.id));
    for (const translated of german) {
      const base = english.find((candidate) => candidate.id === translated.id);
      expect(base).toBeDefined();
      expect(translated.icon).toBe(base!.icon!);
      expect(translated.order).toBe(base!.order);
    }
    expect(notebookHelp.getMarkdown("notebooks-start", "de-CH")).toContain("Notizbücher sind Arbeitsbereiche");
    expect(notebookHelp.getMarkdown("notebooks-start", "fr")).toBe(notebookHelp.getMarkdown("notebooks-start", "en")!);
  });

  test("keeps German articles structurally complete", () => {
    const count = (source: string, pattern: RegExp) => source.match(pattern)?.length ?? 0;
    for (const id of expectedIds) {
      const english = notebookHelp.getMarkdown(id, "en")!;
      const german = notebookHelp.getMarkdown(id, "de-CH")!;
      expect(german.length, `${id} must not be an abbreviated translation`).toBeGreaterThan(english.length * 0.65);
      expect(count(german, /^#{2,4} /gm), `${id} heading coverage`).toBe(count(english, /^#{2,4} /gm));
      expect(count(german, /^```/gm), `${id} code-fence coverage`).toBe(count(english, /^```/gm));
      expect(count(german, /^\|(?: *:?-+:? *\|)+$/gm), `${id} table coverage`).toBe(count(english, /^\|(?: *:?-+:? *\|)+$/gm));
    }
  });

  test("renders the complete corpus without leaking guided-help syntax", () => {
    for (const id of expectedIds) {
      const html = document(id).html;
      expect(html).not.toContain("<p>:::");
      expect(html).not.toContain('{icon="');
      expect(html).toMatch(/<h2 id="[^"]+"/);
    }
  });

  test("distinguishes guided steps from reference paths", () => {
    const html = document("notebooks-start").html;
    expect(html).toContain("<ol ");
    expect(html).toContain("<strong>Write:</strong>");
    expect(html).toContain("<ul ");
    expect(html).toContain("<strong>Capture notes:</strong>");
  });

  test("documents data, query, toc and the current view contract without a scripting API", () => {
    expect(notebookHelp.getMarkdown("notebooks-scripts")).toBeUndefined();
    expect(notebookHelp.getMarkdown("notebooks-script-api")).toBeUndefined();
    for (const locale of ["en", "de"]) {
      const blocks = notebookHelp.getMarkdown("notebooks-structured-blocks", locale)!;
      for (const syntax of [":::data", ":::query", ":::toc", "match: any", "contains-all", "profile.reviewDays"])
        expect(blocks).toContain(syntax);
      expect(blocks).not.toContain("current.");
    }
    expect(document("notebooks-settings-access").markdown).not.toContain("enable scripts");
    expect(document("notebooks-troubleshooting").markdown).toContain("Executable scripting is no longer supported");
  });

  test("renders formula references as scannable tables", () => {
    const html = document("notebooks-table-formulas").html;
    expect(html).toContain('<h3 id="progress-and-percentages">Progress and percentages</h3>');
    expect(html).toContain('<div class="md-table-wrap">');
    expect(html).toContain(">Result and notes</span>");
    expect(html).toContain(">PROGRESS</code></span>");
  });

  test("structured examples follow the real data, query and renderer contracts", () => {
    for (const locale of ["en", "de"]) {
      const markdown = notebookHelp.getMarkdown("notebooks-structured-blocks", locale)!;
      const examples = [...markdown.matchAll(/```text\n([\s\S]*?)```/g)].map((match) => match[1]!);
      expect(examples).toHaveLength(3);
      for (const source of examples) {
        expect(extractNamedDataProperties(source).diagnostics).toEqual([]);
        const queries = parseNotebookQueryBlocks(source);
        expect(queries.diagnostics).toEqual([]);
        expect(parseNotebookTocBlocks(source).diagnostics).toEqual([]);
        const result = renderNotebookBook({
          markdown: source,
          notebookId: "ABC123",
          locale,
          queryResults: new Map(
            queries.blocks.map((query) => [
              query.line,
              {
                columns: query.columns,
                items: [],
                total: 0,
                limit: query.limit,
                truncated: false,
                diagnostics: [],
              },
            ]),
          ),
        });
        expect(result.html).not.toContain("<script");
        expect(result.html.length).toBeGreaterThan(0);
      }
    }
  });
});
