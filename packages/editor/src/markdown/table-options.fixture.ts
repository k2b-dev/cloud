import { anchorHash, parseNoteLink } from "./lib/heading-anchors";
import type { PrettyTableOptions } from "./pretty-table";
export const tableOptions = (): Omit<PrettyTableOptions, "locale"> => ({
  resolveUrl: (kind, ref) => {
    if (kind === "tag") return `/tags/${encodeURIComponent(ref)}`;
    const note = parseNoteLink(ref);
    return note ? `/notes/${note.noteId}${anchorHash(note.anchor)}` : ref;
  },
});
