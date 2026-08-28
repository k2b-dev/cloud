/**
 * Browser-side helpers for the `attach://<shortId>` URL scheme + the click
 * download flow. Used by both lib/editor decorations and the editor
 * components — neutral location to avoid backwards-layered imports.
 *
 * Server-safe regex copies live in `service/attachments.ts`.
 */
import { prompts } from "@k2b/ui";
import { notebookWorkspaceMessages } from "../../[id]/messages";

const ATTACHMENT_URL_RE = /^attach:\/\/([0-9a-zA-Z]{6})$/;
const ATTACHMENT_REF_RE_GLOBAL = /attach:\/\/([0-9a-zA-Z]{6})/g;

export const extractAttachmentId = (url: string): string | null => url.match(ATTACHMENT_URL_RE)?.[1] ?? null;

/** Extract all unique attachment short-ids referenced in a markdown body.
 *  Browser-safe twin of `service/attachments.ts:extractIds`. */
export const extractAttachmentIds = (md: string | null): string[] => {
  if (!md) return [];
  const ids = new Set<string>();
  for (const m of md.matchAll(ATTACHMENT_REF_RE_GLOBAL)) ids.add(m[1]!);
  return Array.from(ids);
};

/** Notebook-scoped content URL with public short IDs end-to-end. */
export const buildAttachmentContentUrl = (notebookId: string, attachmentId: string): string =>
  `/api/notebooks/${encodeURIComponent(notebookId)}/attachments/${encodeURIComponent(attachmentId)}/content?v=1`;

const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export const isSafeMarkdownUrl = (url: string): boolean => {
  if (url.startsWith("//")) return false;
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url)) return true;
  try {
    return SAFE_URL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
};

/**
 * Shared click-to-download flow used by image widgets and file pills.
 * Confirms first to avoid accidental downloads while editing.
 */
export const confirmAndDownload = async (filename: string, url: string): Promise<void> => {
  if (!isSafeMarkdownUrl(url)) return;
  const t = notebookWorkspaceMessages.resolve([document.documentElement.lang]).t;
  const confirmed = await prompts.confirm(t.downloadAttachmentQuestion({ filename }), {
    title: t.downloadAttachment,
    icon: "ti ti-download",
    confirmText: t.download,
  });
  if (!confirmed) return;
  window.open(url, "_blank", "noopener,noreferrer");
};
