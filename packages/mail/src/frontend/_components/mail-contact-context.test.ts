import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { contactOpenHref, type contactResolveMatchSchema } from "../../app-integration-contracts";
import { buildMailContactParticipantRows } from "./mail-contact-context";

type ContactMatch = z.infer<typeof contactResolveMatchSchema>;

const contact = (id: string, bookId: string, email: string): ContactMatch => ({
  ref: { type: "contacts.contact", id },
  contactId: id,
  bookId,
  bookName: `Book ${bookId}`,
  displayName: `Contact ${id}`,
  companyName: null,
  jobTitle: null,
  matchedEmails: [email],
  emails: [{ label: "Email", email }],
  phones: [],
  contactPointsTruncated: false,
  openHref: `/app/contacts/${bookId}?contact=${id}`,
  updatedAt: "2026-07-21T10:00:00.000Z",
});

describe("Mail contact context", () => {
  test("projects optional capability links without inferring a Contacts route", () => {
    expect(contactOpenHref(undefined)).toBeNull();
    expect(contactOpenHref([{ rel: "edit", href: "/app/contacts/book?contact=one" }])).toBe("/app/contacts/book?contact=one");
    expect(
      contactOpenHref([
        { rel: "edit", href: "/app/contacts/book?contact=one&edit=true" },
        { rel: "open", href: "/app/contacts/book?contact=one" },
      ]),
    ).toBe("/app/contacts/book?contact=one");
  });

  test("groups multiple exact contacts under one participant", () => {
    const rows = buildMailContactParticipantRows({
      participants: [{ email: "ada@example.com", displayName: "Ada" }],
      contacts: [
        contact("11111111-1111-4111-8111-111111111111", "book-a", "ada@example.com"),
        contact("22222222-2222-4222-8222-222222222222", "book-b", "ada@example.com"),
      ],
      matchedEmails: ["ada@example.com"],
    });

    expect(rows[0]?.contacts).toHaveLength(2);
    expect(rows[0]?.hasMatch).toBe(true);
    expect(rows[0]?.showParticipantHeading).toBe(true);
  });

  test("collapses a single exact contact into one visible identity", () => {
    const rows = buildMailContactParticipantRows({
      participants: [{ email: "ada@example.com", displayName: "Ada" }],
      contacts: [contact("11111111-1111-4111-8111-111111111111", "book-a", "ada@example.com")],
      matchedEmails: ["ada@example.com"],
    });

    expect(rows[0]?.contacts).toHaveLength(1);
    expect(rows[0]?.showParticipantHeading).toBe(false);
  });

  test("does not offer creation for a match on a later page", () => {
    const rows = buildMailContactParticipantRows({
      participants: [{ email: "later@example.com", displayName: null }],
      contacts: [],
      matchedEmails: ["later@example.com"],
    });

    expect(rows).toEqual([{ email: "later@example.com", displayName: null, contacts: [], hasMatch: true, showParticipantHeading: false }]);
  });

  test("marks an unmatched participant as eligible for creation", () => {
    const rows = buildMailContactParticipantRows({
      participants: [{ email: "new@example.com", displayName: "New Person" }],
      contacts: [],
      matchedEmails: [],
    });

    expect(rows[0]?.hasMatch).toBe(false);
  });
});
