import { describe, expect, test } from "bun:test";
import { renderedHeadingLine } from "@k2b/editor/markdown/lib/heading-anchors";
import { renderNotebookBook } from "./book-renderer";

describe("heading anchors", () => {
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
