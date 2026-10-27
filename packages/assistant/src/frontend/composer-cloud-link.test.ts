import { expect, test } from "bun:test";
import { pastedLinkPlace, withoutPastedLink } from "./composer-cloud-link";

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
