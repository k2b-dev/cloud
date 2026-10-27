import { expect, test } from "bun:test";
import { pastedLinkCurrent, pastedLinkPlace, withoutPastedLink } from "./composer-cloud-link";

const LINK = "https://cloud.example/app/spaces/Spc001?item=Itm001";
const at = (start: number, end = start) => ({ start, end });

test("the place is the draft right after the paste, with the link at its pasted position", () => {
  expect(pastedLinkPlace(`Check  and ${LINK}`, at(6), `${LINK}\r\n`, LINK)).toEqual({
    draft: `Check ${LINK}\n and ${LINK}`,
    at: 6,
  });
  // A selection the paste replaced is gone from it.
  expect(pastedLinkPlace("Old text", at(4, 8), LINK, LINK)).toEqual({ draft: `Old ${LINK}`, at: 4 });
});

test("removing the link takes exactly the pasted copy and keeps one space between words", () => {
  const place = pastedLinkPlace(`Check  and ${LINK}`, at(6), LINK, LINK);
  expect(withoutPastedLink(place.draft, place, LINK)).toBe(`Check and ${LINK}`);
  const middle = pastedLinkPlace("See  today", at(4), LINK, LINK);
  expect(withoutPastedLink(middle.draft, middle, LINK)).toBe("See today");
  const end = pastedLinkPlace("See ", at(4), LINK, LINK);
  expect(withoutPastedLink(end.draft, end, LINK)).toBe("See");
  const only = pastedLinkPlace("", at(0), LINK, LINK);
  expect(withoutPastedLink(only.draft, only, LINK)).toBe("");
});

test("an edit, a restored draft, or other text is no longer this paste's draft", () => {
  const place = pastedLinkPlace("Old text", at(0, 8), LINK, LINK);
  expect(pastedLinkCurrent({ edited: false, draft: LINK }, place)).toBe(true);
  // Typing, undo, or "Use saved draft" restoring a draft that happens to read the same.
  expect(pastedLinkCurrent({ edited: true, draft: LINK }, place)).toBe(false);
  expect(pastedLinkCurrent({ edited: false, draft: `${LINK} ` }, place)).toBe(false);
});
