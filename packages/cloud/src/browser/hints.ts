import { mergeSeenHints, parseSeenHintsCookieHeader, seenHintsSetCookie } from "../contracts/seen-hints";

/** Persist dismissal before navigating or closing the hint. */
export const markHintSeen = (id: string): void => {
  document.cookie = seenHintsSetCookie(mergeSeenHints(parseSeenHintsCookieHeader(document.cookie), id), location.protocol === "https:");
};
