/** A link pasted into the composer: the draft right after the paste, and where the link starts in it. */
export type PastedLinkPlace = { draft: string; at: number };

/**
 * Whether the draft is still the one this paste left: no input in the field but the paste itself, no restored draft
 * (both count as `edited`), and the same text.
 */
export const pastedLinkCurrent = (now: { edited: boolean; draft: string }, place: PastedLinkPlace): boolean =>
  !now.edited && now.draft === place.draft;

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
 * Watches the composer's text field from a paste on. Any key other than a modifier, and any input other than the
 * paste's own, means the pasted link may no longer be this paste's link: a text equal to an earlier one cannot tell,
 * and the composer handles undo keys itself without an input event.
 */
export const watchPastedLink = (field: HTMLTextAreaElement) => {
  let ownPaste = true;
  let edited = false;
  const onInput = (event: Event) => {
    if (ownPaste && "inputType" in event && event.inputType === "insertFromPaste") {
      if (event.type === "input") ownPaste = false;
    } else edited = true;
  };
  const onKey = (event: KeyboardEvent) => {
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) edited = true;
  };
  field.addEventListener("beforeinput", onInput);
  field.addEventListener("input", onInput);
  field.addEventListener("keydown", onKey);
  return {
    edited: () => edited,
    stop: () => {
      field.removeEventListener("beforeinput", onInput);
      field.removeEventListener("input", onInput);
      field.removeEventListener("keydown", onKey);
    },
  };
};

/** The draft without the pasted link, keeping a single space where the link stood between words. */
export const withoutPastedLink = (draft: string, place: PastedLinkPlace, link: string): string => {
  const before = draft.slice(0, place.at);
  const after = draft.slice(place.at + link.length);
  return before.endsWith(" ") && (after.startsWith(" ") || !after) ? before.slice(0, -1) + after : before + after;
};
