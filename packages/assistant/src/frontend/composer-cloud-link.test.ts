import { expect, test } from "bun:test";
import { pastedLinkInPlace, pastedLinkPlace, withoutPastedLink } from "./composer-cloud-link";

const LINK = "https://cloud.example/app/spaces/Spc001?item=Itm001";
const at = (start: number, end = start) => ({ start, end });

test("only this paste's link counts, not another copy of the same link", () => {
  const before = `Check  and ${LINK}`;
  const place = pastedLinkPlace(before, at(6), `${LINK}\r\n`, LINK);
  const draft = `Check ${LINK}\n and ${LINK}`;
  expect(pastedLinkInPlace(draft, place, LINK)).toBe(true);
  expect(withoutPastedLink(draft, place, LINK)).toBe(`Check \n and ${LINK}`);

  // Pasted right before an existing copy, then undone: the older copy is not this paste.
  const pasted = pastedLinkPlace(LINK, at(0), LINK, LINK);
  expect(pastedLinkInPlace(`${LINK}${LINK}`, pasted, LINK)).toBe(true);
  expect(pastedLinkInPlace(LINK, pasted, LINK)).toBe(false);
});

test("an edited, extended, or removed link is no longer this paste's link", () => {
  const place = pastedLinkPlace("See ", at(4), LINK, LINK);
  expect(pastedLinkInPlace(`See ${LINK}`, place, LINK)).toBe(true);
  expect(pastedLinkInPlace("See ", place, LINK)).toBe(false);
  expect(pastedLinkInPlace(`See ${LINK}x`, place, LINK)).toBe(false);
  expect(pastedLinkInPlace(`Now see ${LINK}`, place, LINK)).toBe(false);
  // Typing on after a space keeps the link.
  expect(pastedLinkInPlace(`See ${LINK} today`, place, LINK)).toBe(true);
  // A selection the paste replaced is gone from the expected draft.
  expect(pastedLinkInPlace(`Old ${LINK}`, pastedLinkPlace("Old text", at(4, 8), LINK, LINK), LINK)).toBe(true);
});

test("removing the link keeps one space between words", () => {
  const place = pastedLinkPlace("See  today", at(4), LINK, LINK);
  expect(withoutPastedLink(`See ${LINK} today`, place, LINK)).toBe("See today");
  expect(withoutPastedLink(`See ${LINK}`, pastedLinkPlace("See ", at(4), LINK, LINK), LINK)).toBe("See");
  expect(withoutPastedLink(LINK, pastedLinkPlace("", at(0), LINK, LINK), LINK)).toBe("");
});
