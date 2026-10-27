/** A link pasted into the composer: the draft right after the paste, and where the link starts in it. */
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
 * Watches the composer's text field from a paste on: any input after the paste's own, such as typing, deleting, or
 * undo, means the pasted link may no longer be this paste's link. A text equal to an earlier one cannot tell.
 */
export const watchPastedLink = (field: HTMLTextAreaElement) => {
  let ownPaste = true;
  let edited = false;
  const onInput = (event: Event) => {
    if (ownPaste && "inputType" in event && event.inputType === "insertFromPaste") ownPaste = false;
    else edited = true;
  };
  field.addEventListener("input", onInput);
  return {
    edited: () => edited,
    stop: () => field.removeEventListener("input", onInput),
  };
};

/** The draft without the pasted link, keeping a single space where the link stood between words. */
export const withoutPastedLink = (draft: string, place: PastedLinkPlace, link: string): string => {
  const before = draft.slice(0, place.at);
  const after = draft.slice(place.at + link.length);
  return before.endsWith(" ") && (after.startsWith(" ") || !after) ? before.slice(0, -1) + after : before + after;
};
