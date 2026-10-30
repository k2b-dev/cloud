/** A source reference and the host's resolved destination. */
export type MarkdownUrlKind = "image" | "link";
export type MarkdownUrlOptions = {
  /**
   * Resolve application-owned schemes; ordinary URLs may be returned unchanged. For an image, the result may also be a
   * `blob:` URL, such as one for an image the browser stores locally; links stay limited to safe protocols.
   */
  resolveUrl?: (kind: MarkdownUrlKind, ref: string) => string;
  /** A reference link opened while keeping the editor selection. */
  openLink?: (url: string, ref: string, label: string) => void;
  /** An image opened by pointer or keyboard. */
  openImage?: (image: HTMLImageElement, url: string, label: string) => void;
  /** Show external image sources as links without fetching them. Defaults to false. */
  foreignImagesAsLinks?: boolean;
};

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

export const extractAttachmentId = (url: string): string | null => /^attach:\/\/([0-9a-zA-Z]{6})$/.exec(url)?.[1] ?? null;
