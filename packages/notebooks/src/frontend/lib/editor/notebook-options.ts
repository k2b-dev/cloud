import { mermaidConfig } from "@k2b/cloud/browser/mermaid";
import type { ListCommandsOptions, MarkdownUrlOptions, MermaidOptions } from "@k2b/editor/markdown";
import { anchorHash, parseNoteLink } from "@k2b/editor/markdown/lib/heading-anchors";
import { extractDataBlocks } from "@k2b/editor/markdown/lib/named-blocks";
import { extractNotebookDirectiveRanges } from "@k2b/editor/markdown/lib/query-blocks";
import { ySyncAnnotation } from "y-codemirror.next";
import { deriveNoteTitle, hasUsableNoteTitle } from "../../../lib/note-title";
import { openAttachedImage, openAttachmentById } from "../attachment-preview";
import { navigateToNotebookNote } from "../soft-navigation";
import { attachmentFromContentUrl, buildAttachmentContentUrl, confirmAndDownload, extractAttachmentId } from "./attachment-url";

export const notebookExcludedRanges = (markdown: string) => [
  ...extractDataBlocks(markdown).map((block) => ({ from: block.blockStart, to: block.blockEnd })),
  ...extractNotebookDirectiveRanges(markdown),
];

export const notebookListOptions: ListCommandsOptions = {
  excludedRanges: notebookExcludedRanges,
  isRemoteTransaction: (transaction) => transaction.annotation(ySyncAnnotation) !== undefined,
};

export const notebookUrlOptions = (notebookId: string): MarkdownUrlOptions => ({
  resolveUrl: (kind, ref) => {
    const attachmentId = extractAttachmentId(ref);
    if (attachmentId) return buildAttachmentContentUrl(notebookId, attachmentId);
    const note = kind === "link" ? parseNoteLink(ref) : null;
    return note
      ? `/app/notebooks/${encodeURIComponent(notebookId)}/notes/${encodeURIComponent(note.noteId)}${anchorHash(note.anchor)}`
      : ref;
  },
  openLink: (url, ref, label) => {
    const attachmentId = extractAttachmentId(ref);
    if (attachmentId) void openAttachmentById(notebookId, attachmentId, label);
    else void navigateToNotebookNote(url);
  },
  openImage: (image, url, label) => {
    const attachment = attachmentFromContentUrl(url, window.location.href);
    if (attachment) openAttachedImage(image, attachment.notebookId, attachment.attachmentId, label);
    else void confirmAndDownload(label || "image", url);
  },
});

export const notebookMermaidOptions: MermaidOptions = {
  configuration: mermaidConfig,
  title: (markdown) => (hasUsableNoteTitle(markdown) ? deriveNoteTitle(markdown) : null),
};
