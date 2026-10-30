import { anchorHash, parseNoteLink } from "@k2b/editor/markdown/lib/heading-anchors";
import type { PrettyTableOptions } from "@k2b/editor/markdown/pretty-table";
export const notebookTableOptions = (notebookId?: string): PrettyTableOptions => ({
  resolveUrl: (kind, ref) => {
    if (kind === "tag") return notebookId ? `/app/notebooks/${notebookId}/tags/${encodeURIComponent(ref.toLowerCase())}` : "#";
    const note = parseNoteLink(ref);
    return notebookId && note ? `/app/notebooks/${notebookId}/notes/${note.noteId}${anchorHash(note.anchor)}` : ref;
  },
});
