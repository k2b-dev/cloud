/**
 * Where a link pasted into the composer stands: the text before it. The link is still this paste's link only while
 * the draft starts with that text followed by the link, so edits before it, or removing it, end the recognition.
 */
export const pastedLinkPrefix = (draft: string, selectionStart: number, pasted: string, link: string): string =>
  draft.slice(0, selectionStart) + pasted.replace(/\r\n?/g, "\n").slice(0, pasted.replace(/\r\n?/g, "\n").indexOf(link));

export const pastedLinkInPlace = (draft: string, prefix: string, link: string): boolean =>
  draft.startsWith(prefix) && draft.startsWith(link, prefix.length);

/** The draft without the pasted link, keeping a single space where the link stood between words. */
export const withoutPastedLink = (draft: string, prefix: string, link: string): string => {
  const after = draft.slice(prefix.length + link.length);
  return prefix.endsWith(" ") && (after.startsWith(" ") || !after) ? prefix.slice(0, -1) + after : prefix + after;
};
