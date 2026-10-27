import { expect, test } from "bun:test";
import { pastedLinkInPlace, pastedLinkPrefix, withoutPastedLink } from "./composer-cloud-link";

const LINK = "https://cloud.example/app/spaces/Spc001?item=Itm001";

test("only this paste's link counts, not the same link elsewhere in the draft", () => {
  // Pasted before an existing copy of the same link.
  const before = `Check  and ${LINK}`;
  const prefix = pastedLinkPrefix(before, 6, `${LINK}\r\n`, LINK);
  const draft = `Check ${LINK}\n and ${LINK}`;
  expect(pastedLinkInPlace(draft, prefix, LINK)).toBe(true);
  expect(withoutPastedLink(draft, prefix, LINK)).toBe(`Check \n and ${LINK}`);
});

test("a removed, edited, or moved link is no longer in place", () => {
  const prefix = pastedLinkPrefix("See ", 4, LINK, LINK);
  expect(pastedLinkInPlace(`See ${LINK}`, prefix, LINK)).toBe(true);
  expect(pastedLinkInPlace("See ", prefix, LINK)).toBe(false);
  expect(pastedLinkInPlace(`See ${LINK.slice(0, -1)}`, prefix, LINK)).toBe(false);
  expect(pastedLinkInPlace(`Now see ${LINK}`, prefix, LINK)).toBe(false);
  // The link pasted after an existing copy, then the new one deleted: the older copy is not this paste.
  const later = pastedLinkPrefix(`${LINK} `, LINK.length + 1, LINK, LINK);
  expect(pastedLinkInPlace(`${LINK} `, later, LINK)).toBe(false);
});

test("removing the link keeps one space between words", () => {
  const prefix = pastedLinkPrefix("See  today", 4, LINK, LINK);
  expect(withoutPastedLink(`See ${LINK} today`, prefix, LINK)).toBe("See today");
  expect(withoutPastedLink(`See ${LINK}`, prefix, LINK)).toBe("See");
  expect(withoutPastedLink(LINK, pastedLinkPrefix("", 0, LINK, LINK), LINK)).toBe("");
});
