import { describe, expect, test } from "bun:test";
import { renderNotebookBook } from "./book-renderer";
import { headingAnchorLine, parseNoteLink } from "./heading-anchors";

describe("heading anchors", () => {
  test("a note link names the note and the Book id of its heading's slug", () => {
    expect(parseNoteLink("note://Ab12Cd")).toEqual({ noteId: "Ab12Cd", anchor: null });
    expect(parseNoteLink("note://Ab12Cd#restore")).toEqual({ noteId: "Ab12Cd", anchor: "heading-restore" });
    expect(parseNoteLink("note://Ab12Cd#Backup%20&%20Restore")?.anchor).toBe("heading-backup-restore");
    expect(parseNoteLink("note://Ab12Cd#%E0%A4%A")?.anchor).toBe("heading-e0-a4-a");
    expect(parseNoteLink("note://Ab12Cd#")?.anchor).toBeNull();
    expect(parseNoteLink("note://Ab12Cd#---")?.anchor).toBeNull();
    for (const href of ["note://Ab12C", "note://Ab12Cd7", "note://Ab12Cd/x", "note://Ab12Cd# x", "javascript:alert(1)//note://Ab12Cd"])
      expect(parseNoteLink(href)).toBeNull();
  });

  test("the editor finds the heading line Book gives each id, and nothing for an unknown id", () => {
    const markdown = [
      "# Handbook",
      "## Backup & Restore",
      "```md",
      "## Restore",
      "```",
      "## Restore ##",
      "Text",
      "### Restore",
      "## [Linked](note://Ab12Cd) *steps*",
    ].join("\n");
    const { headings } = renderNotebookBook({ markdown, notebookId: "Nb12Cd", locale: "en" });
    expect(headings.map((heading) => heading.id)).toEqual([
      "heading-handbook",
      "heading-backup-restore",
      "heading-restore",
      "heading-restore-2",
      "heading-linked-steps",
    ]);
    for (const heading of headings) expect(headingAnchorLine(markdown, heading.id)).toBe(heading.line ?? null);
    expect(headingAnchorLine(markdown, "heading-missing")).toBeNull();
  });
});
