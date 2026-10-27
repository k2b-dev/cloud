/** A link pasted into the composer: the draft right after the paste and where the link starts in it. */
export type PastedLinkPlace = { draft: string; at: number };

export const pastedLinkPlace = (
  draft: string,
  selection: { start: number; end: number },
  pasted: string,
  link: string,
): PastedLinkPlace => {
  const text = pasted.replace(/\r\n?/g, "\n");
  return { draft: draft.slice(0, selection.start) + text + draft.slice(selection.end), at: selection.start + text.indexOf(link) };
};

/**
 * Whether the link is still this paste's link, unchanged: the draft is the one right after the paste, at most with
 * text typed at its end, and a link that ended the draft is followed by nothing or a space. Any other edit, undo, or
 * removal ends the recognition, so it never touches another copy of the same link.
 */
export const pastedLinkInPlace = (draft: string, place: PastedLinkPlace, link: string): boolean => {
  const end = place.at + link.length;
  return draft.startsWith(place.draft) && (draft.length === place.draft.length || place.draft.length > end || /\s/.test(draft[end] ?? ""));
};

/** The draft without the pasted link, keeping a single space where the link stood between words. */
export const withoutPastedLink = (draft: string, place: PastedLinkPlace, link: string): string => {
  const before = draft.slice(0, place.at);
  const after = draft.slice(place.at + link.length);
  return before.endsWith(" ") && (after.startsWith(" ") || !after) ? before.slice(0, -1) + after : before + after;
};
