import { describe, expect, test } from "bun:test";
import { renderPrettyTableHtml } from "./pretty-table";

describe("pretty table rendering", () => {
  test("delegates only inline content while keeping raw formula context and results", () => {
    const rendered: string[] = [];
    const html = renderPrettyTableHtml(
      {
        headers: ["Total Cost", "Result"],
        rows: [
          ["2", '=CONCAT("**literal**", `Total Cost`)'],
          ["2026-05-14T18:01:15.575Z", ""],
        ],
      },
      {
        locale: "en",
        renderInline: (raw) => {
          rendered.push(raw);
          return `<em>${raw}</em>`;
        },
      },
    );
    expect(rendered).toEqual(["Total Cost", "Result", "2", ""]);
    expect(html).toContain('<th scope="col"><span class="md-table-cell"><em>Total Cost</em>');
    expect(html).toContain("</i>**literal**2</span>");
    expect(html).toContain('<time datetime="2026-05-14T18:01:15.575Z"');
    expect(html).not.toContain("md-formula-error");
  });

  test("renders inline markdown formatting in body cells", () => {
    const html = renderPrettyTableHtml({
      headers: ["Item", "Meta"],
      rows: [["**Summary**", "`code` and *italic* and ~~done~~"]],
    });

    expect(html).toContain("<strong>Summary</strong>");
    expect(html).not.toContain("**Summary**");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<s>done</s>");
  });

  test("keeps note links and tags pretty while rendering inline markdown", () => {
    const html = renderPrettyTableHtml(
      {
        headers: ["Idea"],
        rows: [["**Build** [Treehouse](note://5ARr8F) #garden"]],
      },
      { notebookId: "nb1234" },
    );

    expect(html).toContain("<strong>Build</strong>");
    expect(html).toContain('href="/app/notebooks/nb1234/notes/5ARr8F"');
    expect(html).toContain('href="/app/notebooks/nb1234/tags/garden"');
  });

  test("note links to a heading open the note at the heading's Book id", () => {
    const html = renderPrettyTableHtml(
      { headers: ["Link"], rows: [["[Restore](note://5ARr8F#restore) [Top](note://5ARr8F#)"]] },
      { notebookId: "nb1234" },
    );

    expect(html).toContain('href="/app/notebooks/nb1234/notes/5ARr8F#heading-restore"');
    expect(html).toContain('href="/app/notebooks/nb1234/notes/5ARr8F"');
    expect(html).not.toContain("note://");
  });

  test("web, mail and relative links render with the same kinds as in Book", () => {
    const html = renderPrettyTableHtml(
      {
        headers: ["Links"],
        rows: [["[Site](https://example.test) [Mail](mailto:a@b.test) [Guide](/files/guide.pdf) [Top](#top) [x](javascript:alert(1))"]],
      },
      { notebookId: "nb1234", locale: "en" },
    );

    expect(html).toContain(
      '<a href="https://example.test" class="k2b-text-link" data-link="web" target="_blank" rel="noopener noreferrer">Site',
    );
    expect(html).toContain(
      '<a href="mailto:a@b.test" class="k2b-text-link" data-link="mail" target="_blank" rel="noopener noreferrer">Mail</a>',
    );
    expect(html).toContain('<a href="/files/guide.pdf" class="k2b-reference" data-reference="pdf" aria-label="PDF: Guide">');
    expect(html).toContain('<a href="#top" class="k2b-reference" data-reference="heading" aria-label="Heading: Top">');
    expect(html).not.toContain('javascript:alert(1)"');
    expect(html).toContain("[x](javascript:alert(1))");
  });

  test("formats standalone ISO date-time strings", () => {
    const html = renderPrettyTableHtml({
      headers: ["created", "title"],
      rows: [["2026-05-14T18:01:15.575Z", "2026-05-13"]],
    });

    expect(html).toContain('<time datetime="2026-05-14T18:01:15.575Z"');
    expect(html).toContain("May 14, 2026, 18:01");
    expect(html).toContain(">2026-05-13<");
  });

  test("localizes formula numbers, errors, and suggestions without changing formula syntax", () => {
    const html = renderPrettyTableHtml(
      {
        headers: ["Preis"],
        rows: [["=1.5"], ["=pries"]],
      },
      { locale: "de-DE" },
    );

    expect(html).toContain(">1,5</span>");
    expect(html).toContain("Unbekannte Spalte");
    expect(html).toContain("Vorschlag: Preis");
    expect(html).toContain("=pries");
    expect(html).not.toContain("Unknown column");
    expect(html).not.toContain("Suggestion:");

    const swissHtml = renderPrettyTableHtml({ headers: ["Preis"], rows: [["=pries"]] }, { locale: "de-CH" });
    expect(swissHtml).toContain("Unbekannte Spalte");
  });
});
