import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  type CapabilityActionDefinition,
  type CapabilityActionReviewResult,
  CapabilityActionReviewSchema,
  type CapabilityExecutionContext,
  capabilityResultSchema,
  type User,
} from "@valentinkolb/cloud/contracts";
import { audit } from "@valentinkolb/cloud/services";
import { contactsCapabilities, decodeContactCapabilityCursor } from "./capabilities";
import {
  CONTACT_COLLECTION_LIMIT,
  CONTACT_TAG_LIMIT,
  ContactCreateInputSchema,
  ContactDetailDataSchema,
  ContactListInputSchema,
  ContactResolveDataSchema,
  ContactSuggestDataSchema,
  ContactTagChangeInputSchema,
  ContactUpdateInputSchema,
} from "./capability-contracts";
import { type Contact, contactsService } from "./service";
import * as publicResources from "./service/public-resources";

const userId = "11111111-1111-4111-8111-111111111111";
const bookId = "22222222-2222-4222-8222-222222222222";
const contactId = "33333333-3333-4333-8333-333333333333";
const publicBookId = "Book01";
const publicContactId = "Cont01";
const publicTagId = "Tag001";
const timestamp = "2026-08-02T08:00:00.000Z";

test("only exposes remembered approval for bounded contact changes", () => {
  const rememberable = (Object.entries(contactsCapabilities.actions) as Array<[string, CapabilityActionDefinition]>)
    .filter(([, action]) => action.approval === "rememberable")
    .map(([localId]) => localId)
    .sort();
  expect(rememberable).toEqual(["contact.create", "contact.update", "favorite.set", "note.create", "tag.change"]);
});

const user = {
  id: userId,
  uid: "contacts-admin",
  roles: ["admin"],
  provider: "local",
  profile: "user",
  givenname: "Contacts",
  sn: "Admin",
  displayName: "Contacts Admin",
  mail: "contacts@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

const context = {
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId },
  user,
  signal: new AbortController().signal,
} satisfies CapabilityExecutionContext;

const contact: Contact = {
  id: contactId,
  bookId,
  label: null,
  firstName: "Ada",
  lastName: "Example",
  companyName: null,
  department: null,
  jobTitle: null,
  vatId: null,
  birthday: null,
  salutation: null,
  pronouns: null,
  preferredLanguage: null,
  source: "manual",
  createdAt: timestamp,
  updatedAt: timestamp,
  emails: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      contactId,
      label: "work",
      email: "ada@example.test",
      position: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  phones: [],
  addresses: [],
  websites: [
    {
      id: "55555555-5555-4555-8555-555555555555",
      contactId,
      label: "legacy import",
      url: "Example GmbH",
      position: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  bankAccounts: [],
  parentContactId: null,
  parent: null,
  members: [],
  tags: [],
};

const book = { id: bookId, name: "Test", description: null, createdAt: timestamp, updatedAt: timestamp };

const publicContact = <T extends Contact>(value: T): T => ({
  ...value,
  id: publicContactId,
  bookId: publicBookId,
  parentContactId: value.parentContactId ? publicContactId : null,
  emails: value.emails.map((item) => ({ ...item, contactId: publicContactId })),
  phones: value.phones.map((item) => ({ ...item, contactId: publicContactId })),
  addresses: value.addresses.map((item) => ({ ...item, contactId: publicContactId })),
  websites: value.websites.map((item) => ({ ...item, contactId: publicContactId })),
  bankAccounts: value.bankAccounts.map((item) => ({ ...item, contactId: publicContactId })),
  tags: value.tags.map((item) => ({ ...item, id: publicTagId, bookId: publicBookId })),
});

beforeEach(() => {
  spyOn(publicResources, "resolvePublicId").mockImplementation(async (table, value) => {
    if (table === "books" && value === publicBookId) return bookId;
    if (table === "contacts" && value === publicContactId) return contactId;
    return null;
  });
  spyOn(publicResources, "resolvePublicIds").mockImplementation(async (table, values) =>
    table === "contacts" && values.every((value) => value === publicContactId) ? values.map(() => contactId) : null,
  );
  spyOn(publicResources, "resolveBookPublicIds").mockImplementation(async (table, internalBookId, values) => {
    if (internalBookId !== bookId) return null;
    if (table === "contacts" && values.every((value) => value === publicContactId)) return values.map(() => contactId);
    if (table === "tags" && values.every((value) => value === publicTagId)) return values.map(() => "66666666-6666-4666-8666-666666666666");
    return null;
  });
  spyOn(publicResources, "projectBooks").mockImplementation(async (items) => items.map((item) => ({ ...item, id: publicBookId })));
  spyOn(publicResources, "projectContacts").mockImplementation(async (items) => items.map((item) => publicContact(item)));
  spyOn(publicResources, "projectTags").mockImplementation(async (items) =>
    items.map((item) => ({ ...item, id: publicTagId, bookId: publicBookId })),
  );
  spyOn(publicResources, "projectContactReferences").mockImplementation(async (items) =>
    items.map((item) => ({ ...item, contactId: publicContactId, bookId: publicBookId })),
  );
});

afterEach(() => mock.restore());

describe("contacts capabilities", () => {
  test("declares the complete local v1 surface", () => {
    expect(Object.keys(contactsCapabilities.types).sort()).toEqual(["book", "contact", "note", "tag"]);
    expect(Object.keys(contactsCapabilities.queries).sort()).toEqual([
      "book.list",
      "book.read",
      "contact.list",
      "contact.read",
      "contact.resolve",
      "contact.search",
      "contact.suggest",
      "note.list",
      "note.read",
      "tag.list",
      "tag.read",
    ]);
    expect(Object.keys(contactsCapabilities.actions).sort()).toEqual([
      "contact.create",
      "contact.delete",
      "contact.move",
      "contact.update",
      "favorite.set",
      "note.create",
      "tag.change",
    ]);
    expect(
      Object.entries(contactsCapabilities.actions)
        .filter(([, action]) => "review" in action && action.review)
        .map(([id]) => id)
        .sort(),
    ).toEqual(["contact.create", "contact.delete", "contact.move", "contact.update", "favorite.set", "note.create", "tag.change"]);
  });

  test("separates general contact discovery from mail-specific lookup", () => {
    expect(contactsCapabilities.queries["contact.search"].description).toContain("Find, show, or open");
    expect(contactsCapabilities.queries["contact.search"].description).toContain("navigable contact cards");
    expect(contactsCapabilities.queries["contact.suggest"].description).toContain("composing mail");
    expect(contactsCapabilities.queries["contact.resolve"].description).toContain("known exact email addresses");
    expect(contactsCapabilities.queries["contact.list"].description).toContain("navigable contact cards");
    expect(contactsCapabilities.queries["contact.list"].description).toContain("opaque pagination");
    expect(contactsCapabilities.queries["book.list"].title).toBe("List address books");
  });

  test("reviews a destructive contact action without mutating it", async () => {
    spyOn(contactsService.contact, "findBookId").mockResolvedValue(bookId);
    spyOn(contactsService.book, "get").mockResolvedValue(book);
    spyOn(contactsService.contact, "get").mockResolvedValue(contact);
    const remove = spyOn(contactsService.contact, "remove");
    const review = contactsCapabilities.actions["contact.delete"].review;
    if (!review) throw new Error("Contact delete review missing");

    const result = await review({ contactId: publicContactId, expectedUpdatedAt: timestamp }, context);

    expect(result).toMatchObject({ ok: true, data: { message: "Permanently delete Ada Example." } });
    expect(remove).not.toHaveBeenCalled();
  });

  test("returns one semantic Cloud link with each listed contact", async () => {
    spyOn(contactsService.book, "get").mockResolvedValue(book);
    spyOn(contactsService.contact, "list").mockResolvedValue({
      items: [contact],
      page: 1,
      perPage: 25,
      total: 1,
      hasNext: false,
    });

    const result = await contactsCapabilities.queries["contact.list"].run(
      { bookId: publicBookId, sort: "name", email: "all", phone: "all", favoritesOnly: false, limit: 25 },
      context,
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.data.data).toEqual([
      {
        ref: { type: "contacts.contact", id: publicContactId },
        title: "Ada Example",
        preview: "ada@example.test",
        icon: "ti ti-address-book",
        priority: 7,
        metadata: [
          { label: "Type", value: "Contact" },
          { label: "Book", value: publicBookId },
        ],
        links: [{ rel: "open", href: `/app/contacts/${publicBookId}?contact=${publicContactId}&contactBook=${publicBookId}` }],
      },
    ]);
  });

  test("keeps legacy website text from invalidating an otherwise readable contact", async () => {
    spyOn(contactsService.contact, "findBookId").mockResolvedValue(bookId);
    spyOn(contactsService.book, "get").mockResolvedValue(book);
    spyOn(contactsService.contact, "get").mockResolvedValue(contact);

    const definition = contactsCapabilities.queries["contact.read"];
    const result = await definition.run({ id: publicContactId }, context);

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(definition.data.safeParse(result.data.data).success).toBeTrue();
    expect(result.data.data.websites).toEqual([]);
    expect(result.data.data.truncatedFields).toEqual([]);
    expect(result.data.links).toEqual([
      { rel: "open", href: `/app/contacts/${publicBookId}?contact=${publicContactId}&contactBook=${publicBookId}` },
    ]);
  });

  test("rejects ambiguous or empty contact writes", () => {
    expect(ContactCreateInputSchema.safeParse({ bookId: "553cd2c2-6dd8-47c7-bd2d-f731e78bc7ef" }).success).toBeFalse();
    expect(
      ContactUpdateInputSchema.safeParse({
        contactId: "553cd2c2-6dd8-47c7-bd2d-f731e78bc7ef",
        expectedUpdatedAt: "2026-08-01T10:00:00.000Z",
      }).success,
    ).toBeFalse();
  });

  test("keeps advertised contact writes below the capability transport envelope", () => {
    const text = (length: number) => "x".repeat(length);
    const input = {
      bookId: publicBookId,
      label: "A",
      emails: Array.from({ length: CONTACT_COLLECTION_LIMIT }, () => ({ label: text(100), email: `${text(50)}@example.com` })),
      phones: Array.from({ length: CONTACT_COLLECTION_LIMIT }, () => ({ label: text(100), phone: text(100) })),
      addresses: Array.from({ length: CONTACT_COLLECTION_LIMIT }, () => ({
        label: text(100),
        recipientName: text(200),
        companyName: text(200),
        line1: text(300),
        line2: text(300),
        postalCode: text(50),
        city: text(200),
        stateRegion: text(200),
        countryCode: "DE",
      })),
      websites: Array.from({ length: CONTACT_COLLECTION_LIMIT }, (_, index) => ({
        label: text(100),
        url: `https://example.com/${text(1900)}${index}`,
      })),
      bankAccounts: Array.from({ length: CONTACT_COLLECTION_LIMIT }, () => ({
        label: text(100),
        accountHolderName: text(200),
        iban: text(80),
        bic: text(40),
        bankName: text(200),
        note: text(1000),
      })),
    };
    expect(ContactCreateInputSchema.safeParse(input).success).toBeTrue();
    expect(Buffer.byteLength(JSON.stringify({ input }))).toBeLessThan(200_000);
    expect(
      ContactCreateInputSchema.safeParse({
        bookId: publicBookId,
        firstName: "Ada",
        emails: Array(CONTACT_COLLECTION_LIMIT + 1).fill({ email: "a@b.co" }),
      }).success,
    ).toBeFalse();
  });

  test("bounds legacy contact collections and reports every truncated field", async () => {
    const tag = {
      id: "66666666-6666-4666-8666-666666666666",
      bookId,
      name: "Test",
      color: "#112233",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const oversized = {
      ...contact,
      tags: Array(CONTACT_TAG_LIMIT + 1).fill(tag),
      emails: Array(CONTACT_COLLECTION_LIMIT + 1).fill(contact.emails[0]!),
      phones: Array(CONTACT_COLLECTION_LIMIT + 1).fill({
        id: "77777777-7777-4777-8777-777777777777",
        contactId,
        label: "work",
        phone: "+49 123",
        position: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      addresses: [],
      websites: [],
      bankAccounts: [],
    } satisfies Contact;
    spyOn(contactsService.contact, "findBookId").mockResolvedValue(bookId);
    spyOn(contactsService.book, "get").mockResolvedValue(book);
    spyOn(contactsService.contact, "get").mockResolvedValue(oversized);

    const result = await contactsCapabilities.queries["contact.read"].run({ id: publicContactId }, context);
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(ContactDetailDataSchema.safeParse(result.data.data).success).toBeTrue();
    expect(result.data.data.tags).toHaveLength(CONTACT_TAG_LIMIT);
    expect(result.data.data.emails).toHaveLength(CONTACT_COLLECTION_LIMIT);
    expect(result.data.data.phones).toHaveLength(CONTACT_COLLECTION_LIMIT);
    expect(result.data.data.truncatedFields).toEqual(["tags", "emails", "phones"]);
  });

  test("shows bounded before and after values when reviewing contact updates", async () => {
    spyOn(contactsService.contact, "findBookId").mockResolvedValue(bookId);
    spyOn(contactsService.book, "get").mockResolvedValue(book);
    spyOn(contactsService.contact, "get").mockResolvedValue(contact);
    const review = contactsCapabilities.actions["contact.update"].review;
    if (!review) throw new Error("Contact update review missing");

    const result = await review(
      {
        contactId: publicContactId,
        expectedUpdatedAt: timestamp,
        firstName: "Grace",
        birthday: "1990-05-12",
        emails: [{ label: "work", email: "grace@example.test" }],
      },
      context,
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.data.details).toContainEqual({ label: "First name", value: "Ada → Grace" });
    expect(result.data.details).toContainEqual({ label: "Current birthday", value: "None" });
    expect(result.data.details).toContainEqual({ label: "New birthday", value: "1990-05-12", format: "date" });
    expect(result.data.details).toContainEqual({
      label: "Email addresses",
      value: "Current\n1. work — ada@example.test\n\nProposed\n1. work — grace@example.test",
      display: "block",
    });
    expect(result.data.approvalScope).toBe(`book:${publicBookId}`);
  });

  test("summarizes contact changes as user-visible outcomes", async () => {
    spyOn(contactsService.contact, "findBookId").mockResolvedValue(bookId);
    spyOn(contactsService.book, "get").mockResolvedValue(book);
    spyOn(contactsService.contact, "get").mockResolvedValue(contact);
    spyOn(audit, "recordResultAfterSideEffect").mockImplementation(async ({ result }) => result);

    spyOn(contactsService.contact, "update").mockResolvedValue({
      ok: true,
      data: { ...contact, emails: [{ ...contact.emails[0]!, email: "grace@example.test" }] },
    });
    const update = await contactsCapabilities.actions["contact.update"].run(
      {
        contactId: publicContactId,
        expectedUpdatedAt: timestamp,
        emails: [{ label: "work", email: "grace@example.test" }],
      },
      context,
    );
    expect(update).toMatchObject({ ok: true, data: { summary: "Changed the email address of Ada Example." } });
    if (update.ok)
      expect(capabilityResultSchema(contactsCapabilities.actions["contact.update"].data).safeParse(update.data).success).toBeTrue();

    const customerTag = {
      id: "66666666-6666-4666-8666-666666666666",
      bookId,
      name: "customer",
      color: "#112233",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    spyOn(contactsService.tag, "changeAssignments").mockResolvedValue({ ok: true, data: [customerTag] });
    const tags = await contactsCapabilities.actions["tag.change"].run(
      { contactId: publicContactId, addTagIds: [publicTagId], removeTagIds: [] },
      context,
    );
    expect(tags).toMatchObject({ ok: true, data: { summary: "Added #customer to Ada Example." } });
    if (tags.ok) expect(capabilityResultSchema(contactsCapabilities.actions["tag.change"].data).safeParse(tags.data).success).toBeTrue();

    spyOn(contactsService.favorite, "set").mockResolvedValue();
    const favorite = await contactsCapabilities.actions["favorite.set"].run({ contactId: publicContactId, favorite: true }, context);
    expect(favorite).toMatchObject({ ok: true, data: { summary: "Ada Example is in favorites." } });
  });

  test("returns a valid app-owned scope from every rememberable action review", async () => {
    const tag = {
      id: "66666666-6666-4666-8666-666666666666",
      bookId,
      name: "Customer",
      color: "#2563eb",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    spyOn(contactsService.contact, "findBookId").mockResolvedValue(bookId);
    spyOn(contactsService.book, "get").mockResolvedValue(book);
    spyOn(contactsService.contact, "get").mockResolvedValue(contact);
    spyOn(contactsService.tag, "list").mockResolvedValue([tag]);

    const tagReview = await contactsCapabilities.actions["tag.change"].review!(
      { contactId: publicContactId, addTagIds: [publicTagId], removeTagIds: [] },
      context,
    );
    const results: CapabilityActionReviewResult[] = [
      await contactsCapabilities.actions["contact.create"].review!({ bookId: publicBookId, label: "New contact" }, context),
      await contactsCapabilities.actions["contact.update"].review!(
        { contactId: publicContactId, expectedUpdatedAt: timestamp, firstName: "Grace" },
        context,
      ),
      await contactsCapabilities.actions["favorite.set"].review!({ contactId: publicContactId, favorite: true }, context),
      tagReview,
      await contactsCapabilities.actions["note.create"].review!({ contactId: publicContactId, content: "Follow up next week." }, context),
    ];

    expect(results).toHaveLength(
      (Object.values(contactsCapabilities.actions) as CapabilityActionDefinition[]).filter((action) => action.approval === "rememberable")
        .length,
    );
    expect(results.map((result) => (result.ok ? result.data.approvalScope : null))).toEqual([
      `book:${publicBookId}`,
      `book:${publicBookId}`,
      "favorites",
      `book:${publicBookId}`,
      `contact:${publicContactId}`,
    ]);
    expect(tagReview).toMatchObject({
      ok: true,
      data: {
        details: [
          { label: "Contact", value: "Ada Example" },
          { label: "Add", value: "Customer" },
          { label: "Remove", value: "None" },
        ],
        links: [{ rel: "open", href: `/app/contacts/${publicBookId}?contact=${publicContactId}&contactBook=${publicBookId}` }],
      },
    });
    for (const [index, result] of results.entries()) {
      expect(result.ok).toBeTrue();
      if (!result.ok) continue;
      expect(result.data.approvalScope?.length).toBeGreaterThan(0);
      const parsed = CapabilityActionReviewSchema.safeParse(result.data);
      if (!parsed.success) throw new Error(`Review ${index} is invalid: ${JSON.stringify(parsed.error.issues)}`);
    }
  });

  test("keeps tag changes explicit and closed", () => {
    expect(
      ContactTagChangeInputSchema.safeParse({
        contactId: "553cd2c2-6dd8-47c7-bd2d-f731e78bc7ef",
        unexpected: true,
      }).success,
    ).toBeFalse();
    expect(
      ContactTagChangeInputSchema.safeParse({
        contactId: "553cd2c2-6dd8-47c7-bd2d-f731e78bc7ef",
        addTagIds: [],
        removeTagIds: [],
      }).success,
    ).toBeFalse();
  });

  test("accepts only opaque v1 page cursors", () => {
    const cursor = Buffer.from(JSON.stringify({ v: 1, page: 4 }), "utf8").toString("base64url");
    expect(decodeContactCapabilityCursor(cursor)).toEqual({ ok: true, data: 4 });
    expect(decodeContactCapabilityCursor("not-a-cursor").ok).toBeFalse();
    const unsafe = Buffer.from(JSON.stringify({ v: 1, page: 1e308 }), "utf8").toString("base64url");
    expect(decodeContactCapabilityCursor(unsafe).ok).toBeFalse();
  });

  test("rejects legacy UUID selectors and does not resolve the former virtual book", async () => {
    expect(ContactListInputSchema.safeParse({ bookId }).success).toBeFalse();
    const result = await contactsCapabilities.queries["contact.list"].run(
      { bookId: "system", sort: "name", email: "all", phone: "all", favoritesOnly: false, limit: 25 },
      context,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("keeps contact suggestions useful for phone searches without exposing full records", () => {
    expect(
      ContactSuggestDataSchema.safeParse([
        {
          ref: { type: "contacts.contact", id: publicContactId },
          contactId: publicContactId,
          bookId: publicBookId,
          displayName: "Ada Example",
          companyName: "Example GmbH",
          jobTitle: null,
          emails: [{ label: "work", email: "ada@example.com" }],
          phones: [{ label: "mobile", phone: "+49 170 1234567" }],
          contactPointsTruncated: false,
          openHref: `/app/contacts/${publicBookId}?contact=${publicContactId}&contactBook=${publicBookId}`,
          links: [
            {
              rel: "open",
              href: `/app/contacts/${publicBookId}?contact=${publicContactId}&contactBook=${publicBookId}`,
            },
          ],
          updatedAt: "2026-08-01T10:00:00.000Z",
        },
      ]).success,
    ).toBeTrue();
  });

  test("emits semantic contact links while preserving the v1 openHref contract", async () => {
    spyOn(contactsService.contact, "search").mockResolvedValue({
      items: [contact],
      page: 1,
      perPage: 8,
      total: 1,
      hasNext: false,
    });
    const suggested = await contactsCapabilities.queries["contact.suggest"].run({ query: "Ada", limit: 8 }, context);
    expect(suggested.ok).toBeTrue();
    if (!suggested.ok) return;
    expect(suggested.data.data[0]).toMatchObject({
      ref: { type: "contacts.contact", id: publicContactId },
      openHref: `/app/contacts/${publicBookId}?contact=${publicContactId}&contactBook=${publicBookId}`,
      links: [{ rel: "open", href: `/app/contacts/${publicBookId}?contact=${publicContactId}&contactBook=${publicBookId}` }],
    });

    spyOn(contactsService.lookup, "resolveContactsByEmail").mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            contactId,
            bookId,
            bookName: "Contacts",
            displayName: "Ada Example",
            companyName: null,
            jobTitle: null,
            matchedEmails: ["ada@example.test"],
            emails: [{ label: "work", email: "ada@example.test" }],
            phones: [],
            contactPointsTruncated: false,
            updatedAt: timestamp,
          },
        ],
        matchedEmails: ["ada@example.test"],
        nextCursor: null,
      },
    });
    const resolved = await contactsCapabilities.queries["contact.resolve"].run({ emails: ["ada@example.test"], limit: 25 }, context);
    expect(resolved.ok).toBeTrue();
    if (!resolved.ok) return;
    expect(resolved.data.data.items[0]).toMatchObject({
      ref: { type: "contacts.contact", id: publicContactId },
      openHref: `/app/contacts/${publicBookId}?contact=${publicContactId}&contactBook=${publicBookId}`,
      links: [{ rel: "open", href: `/app/contacts/${publicBookId}?contact=${publicContactId}&contactBook=${publicBookId}` }],
    });
  });

  test("keeps exact resolution bounded and rejects unrelated contact fields", () => {
    const value = { items: [], matchedEmails: ["ada@example.com"] };
    expect(ContactResolveDataSchema.safeParse(value).success).toBeTrue();
    expect(ContactResolveDataSchema.safeParse({ ...value, bankAccounts: [] }).success).toBeFalse();
  });
});
