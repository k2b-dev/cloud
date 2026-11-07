import { describe, expect, test } from "bun:test";
import { parseNoteLink } from "./heading-anchors";

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
});
