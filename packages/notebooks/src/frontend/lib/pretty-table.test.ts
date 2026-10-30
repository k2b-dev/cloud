import { describe, expect, test } from "bun:test";
import { renderPrettyTableHtml } from "@k2b/editor/markdown/pretty-table";
import { notebookTableOptions } from "../../lib/table-options";

describe("Notebook table routing", () => {
  test("keeps note links and tags pretty while rendering inline markdown", () => {
    const html = renderPrettyTableHtml(
      {
        headers: ["Idea"],
        rows: [["**Build** [Treehouse](note://5ARr8F) #garden"]],
      },
      notebookTableOptions("nb1234"),
    );

    expect(html).toContain("<strong>Build</strong>");
    expect(html).toContain('href="/app/notebooks/nb1234/notes/5ARr8F"');
    expect(html).toContain('href="/app/notebooks/nb1234/tags/garden"');
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
});
