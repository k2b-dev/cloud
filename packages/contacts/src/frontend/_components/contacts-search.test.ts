import { describe, expect, test } from "bun:test";
import { buildContactsQueryHref, readContactsQueryOptions } from "../contacts-query";
import {
  buildContactDetailHref,
  buildContactsPageHref,
  buildContactsPaginationBaseHref,
  buildContactsSearchHref,
  contactsResultHref,
  contactsResultSignature,
} from "./contacts-search";

describe("Contacts search route state", () => {
  test("keeps the visible scope while replacing search-owned state", () => {
    expect(buildContactsSearchHref("/app/contacts/book-1?tag_id=vip&page=4&contact=contact-1&contactBook=book-1", "  Ada Lovelace  ")).toBe(
      "/app/contacts/book-1?tag_id=vip&search=Ada+Lovelace",
    );
  });

  test("clears an empty search and selected detail", () => {
    expect(buildContactsSearchHref("/app/contacts?search=Ada&contact=contact-1&contactBook=book-1", " ")).toBe("/app/contacts");
  });

  test("tracks only result-affecting state and builds pagination links", () => {
    expect(contactsResultSignature("/app/contacts/book-1?search=Ada&contact=one")).toBe(
      contactsResultSignature("/app/contacts/book-1?search=Ada&contact=two"),
    );
    expect(buildContactsPaginationBaseHref("/app/contacts/book-1?tag_id=vip&search=Ada&page=2&contact=one")).toBe(
      "/app/contacts/book-1?tag_id=vip&search=Ada&page=",
    );
    expect(buildContactsPageHref("/app/contacts/book-1?search=Ada&page=9&contact=one", 3)).toBe("/app/contacts/book-1?search=Ada&page=3");
    expect(buildContactsPageHref("/app/contacts/book-1?search=Ada&page=9", 1)).toBe("/app/contacts/book-1?search=Ada");
  });

  test("removes detail selection from the canonical results source", () => {
    expect(contactsResultHref("/app/contacts/book-1?search=Ada&contact=one&contactBook=book-1")).toBe("/app/contacts/book-1?search=Ada");
  });

  test("keeps list scope in real contact detail links", () => {
    expect(buildContactDetailHref("/app/contacts/book-1?search=Ada&tag_id=vip", "contact-1", "book-1")).toBe(
      "/app/contacts/book-1?search=Ada&tag_id=vip&contact=contact-1&contactBook=book-1",
    );
  });

  test("keeps filters URL-backed and clears transient detail state", () => {
    const href = buildContactsQueryHref("/app/contacts/book-1?contact=one&page=4", {
      sort: "created",
      email: "yes",
      favorites: true,
    });
    expect(href).toBe("/app/contacts/book-1?sort=created&email=yes&favorites=true");
    expect(readContactsQueryOptions(href)).toEqual({ sort: "created", email: "yes", phone: "all", favorites: true });
  });
  test("never carries a completed mutation outcome into reusable navigation", () => {
    const href = "/app/contacts/book-1?contact=one&contactBook=book-1&contactOutcome=created&address=old-address";
    for (const result of [
      contactsResultHref(href),
      buildContactsSearchHref(href, "Ada"),
      buildContactsPageHref(href, 2),
      buildContactsPaginationBaseHref(href),
      buildContactsQueryHref(href, { sort: "created" }),
      buildContactDetailHref(href, "other", "book-1"),
    ]) {
      expect(result).not.toContain("contactOutcome");
      expect(result).not.toContain("address=");
    }
  });
});
