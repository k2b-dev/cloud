import { describe, expect, test } from "bun:test";
import { renderNotebookBook } from "./book-renderer";
import { parseNoteLink, renderedHeadingLine } from "./heading-anchors";

describe("heading anchors", () => {
  test("a note link names the note and the Book id of its heading's slug", () => {
    expect(parseNoteLink("note://Ab12Cd")).toEqual({ noteId: "Ab12Cd", anchor: null });
    expect(parseNoteLink("note://Ab12Cd#restore")).toEqual({ noteId: "Ab12Cd", anchor: "heading-restore" });
    expect(parseNoteLink("note://Ab12Cd#Backup%20&%20Restore")?.anchor).toBe("heading-backup-restore");
    expect(parseNoteLink("note://Ab12Cd#%E0%A4%A")?.anchor).toBe("heading-e0-a4-a");
    // A repeated heading's slug carries Book's number; `heading-` belongs to Book's id, not to the slug.
    expect(parseNoteLink("note://Ab12Cd#restore-2")?.anchor).toBe("heading-restore-2");
    expect(parseNoteLink("note://Ab12Cd#heading-restore")?.anchor).toBe("heading-heading-restore");
    expect(parseNoteLink("note://Ab12Cd#")?.anchor).toBeNull();
    expect(parseNoteLink("note://Ab12Cd#---")?.anchor).toBeNull();
    for (const href of ["note://Ab12C", "note://Ab12Cd7", "note://Ab12Cd/x", "note://Ab12Cd# x", "javascript:alert(1)//note://Ab12Cd"])
      expect(parseNoteLink(href)).toBeNull();
  });

  test("the editor opens the line Book gives a heading id, while that line still holds the heading", () => {
    const markdown = [
      ":::info", // 1
      "## Restore", // 2: heading-restore, inside a notice
      ":::",
      "Restore", // 4: heading-restore-2, underlined
      "---",
      "> ## Restore", // 6: heading-restore-3, quoted: Book has no source line for it
      "",
      "## Restore", // 8: heading-restore-4
      "## Back**up**", // 9: heading-backup
      "## Fish &amp; Chips", // 10: heading-fish-chips
      "```md",
      "## Restore",
      "```",
    ].join("\n");
    const book = renderNotebookBook({ markdown, notebookId: "Nb12Cd", locale: "en" });
    const rendered = { markdown, headings: book.headings.flatMap(({ id, line }) => (line === undefined ? [] : [{ id, line }])) };
    const line = (id: string, current = markdown) => renderedHeadingLine(rendered, id, current);

    expect(book.headings.map((heading) => [heading.id, heading.line])).toEqual([
      ["heading-restore", 2],
      ["heading-restore-2", 4],
      ["heading-restore-3", undefined],
      ["heading-restore-4", 8],
      ["heading-backup", 9],
      ["heading-fish-chips", 10],
    ]);
    expect(
      ["heading-restore", "heading-restore-2", "heading-restore-4", "heading-backup", "heading-fish-chips"].map((id) => line(id)),
    ).toEqual([2, 4, 8, 9, 10]);
    expect(line("heading-restore-3")).toBeNull();
    expect(line("heading-missing")).toBeNull();
    // Someone edited the note since Book rendered it: an unchanged heading line opens, a changed one opens the top.
    const edited = markdown.replace("## Back**up**", "## Backups");
    expect(line("heading-restore-4", edited)).toBe(8);
    expect(line("heading-backup", edited)).toBeNull();
    expect(line("heading-restore", "")).toBeNull();
  });
});
