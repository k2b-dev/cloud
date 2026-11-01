import { describe, expect, test } from "bun:test";
import { renderPrettyTableHtml } from "@k2b/editor/markdown/pretty-table";
import { notebookTableOptions } from "../../lib/table-options";

describe("Notebook table routing", () => {
  test("keeps note links and tags pretty while rendering inline markdown", () => {
    const html = renderPrettyTableHtml(
      {
        headers: ["Idea"],
        rows: [["**Build** [Treehouse](note://5ARr8F) #garden #Garden/Build"]],
      },
      notebookTableOptions("nb1234"),
    );

    expect(html).toContain("<strong>Build</strong>");
    expect(html).toContain('href="/app/notebooks/nb1234/notes/5ARr8F"');
    expect(html).toContain('href="/app/notebooks/nb1234/tags/garden"');
    expect(html).toContain('href="/app/notebooks/nb1234/tags/garden%2Fbuild"');
  });

  test("note links to a heading open the note at the heading's Book id", () => {
    const html = renderPrettyTableHtml(
      { headers: ["Link"], rows: [["[Restore](note://5ARr8F#restore) [Top](note://5ARr8F#)"]] },
      notebookTableOptions("nb1234"),
    );

    expect(html).toContain('href="/app/notebooks/nb1234/notes/5ARr8F#heading-restore"');
    expect(html).toContain('href="/app/notebooks/nb1234/notes/5ARr8F"');
    expect(html).not.toContain("note://");
  });

  test("without a notebook, note references and the tag fallback remain unchanged", () => {
    const html = renderPrettyTableHtml({ headers: ["Link"], rows: [["[Treehouse](note://5ARr8F) #Garden/Build"]] }, notebookTableOptions());
    expect(html).toContain('href="note://5ARr8F"');
    expect(html).toContain('href="#"');
    expect(html).not.toContain("/app/notebooks/");
  });
});
