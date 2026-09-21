import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import {
  projectBooks,
  projectContacts,
  projectNotes,
  projectTags,
  resolveBookPublicIds,
  resolvePublicId,
  resolvePublicIds,
} from "./public-resources";

const suite = databaseSuite();

suite("Contacts public resource IDs", () => {
  let bookId = "";
  let otherBookId = "";
  let contactId = "";
  let tagId = "";
  let noteId = "";

  beforeAll(async () => {
    await sql`DELETE FROM contacts.books WHERE short_id IN ('TBook1', 'TBook2')`;
    bookId = (
      await sql<{ id: string }[]>`
      INSERT INTO contacts.books (short_id, name) VALUES ('TBook1', 'Short ID test') RETURNING id
    `
    )[0]!.id;
    otherBookId = (
      await sql<{ id: string }[]>`
      INSERT INTO contacts.books (short_id, name) VALUES ('TBook2', 'Short ID other') RETURNING id
    `
    )[0]!.id;
    contactId = (
      await sql<{ id: string }[]>`
      INSERT INTO contacts.contacts (short_id, book_id, first_name) VALUES ('TCont1', ${bookId}::uuid, 'Ada') RETURNING id
    `
    )[0]!.id;
    tagId = (
      await sql<{ id: string }[]>`
        INSERT INTO contacts.tags (short_id, book_id, name, color) VALUES ('TTag01', ${bookId}::uuid, 'Test', '#112233') RETURNING id
      `
    )[0]!.id;
    noteId = (
      await sql<{ id: string }[]>`
        INSERT INTO contacts.contact_notes (short_id, contact_id, author_display_name, content)
        VALUES ('TNote1', ${contactId}::uuid, 'Tester', 'Note') RETURNING id
      `
    )[0]!.id;
  });

  afterAll(async () => {
    if (bookId || otherBookId) await sql`DELETE FROM contacts.books WHERE id IN (${bookId}::uuid, ${otherBookId}::uuid)`;
  });

  test("resolves only exact short IDs and preserves list order", async () => {
    expect(await resolvePublicId("books", "TBook1")).toBe(bookId);
    expect(await resolvePublicId("books", bookId)).toBeNull();
    expect(await resolvePublicIds("contacts", ["TCont1", "TCont1"])).toEqual([contactId, contactId]);
  });

  test("keeps book ownership at the resolver boundary", async () => {
    expect(await resolveBookPublicIds("contacts", bookId, ["TCont1"])).toEqual([contactId]);
    expect(await resolveBookPublicIds("contacts", otherBookId, ["TCont1"])).toBeNull();
  });

  test("projects internal UUIDs without dual public fields", async () => {
    const [book, contact, tag, note] = await Promise.all([
      projectBooks([{ id: bookId, name: "Short ID test", description: null, createdAt: null, updatedAt: null }]).then((items) => items[0]!),
      projectContacts([
        {
          id: contactId,
          bookId,
          label: null,
          firstName: "Ada",
          lastName: null,
          companyName: null,
          department: null,
          jobTitle: null,
          vatId: null,
          birthday: null,
          salutation: null,
          pronouns: null,
          preferredLanguage: null,
          source: "manual",
          createdAt: "2026-08-11T08:00:00.000Z",
          updatedAt: "2026-08-11T08:00:00.000Z",
          emails: [],
          phones: [],
          addresses: [],
          websites: [],
          bankAccounts: [],
          parentContactId: null,
          parent: null,
          members: [],
          tags: [],
        },
      ]).then((items) => items[0]!),
      projectTags([
        {
          id: tagId,
          bookId,
          name: "Test",
          color: "#112233",
          createdAt: "2026-08-11T08:00:00.000Z",
          updatedAt: "2026-08-11T08:00:00.000Z",
        },
      ]).then((items) => items[0]!),
      projectNotes([
        {
          id: noteId,
          contactId,
          authorUserId: null,
          authorDisplayName: "Tester",
          authorAvatarHash: null,
          content: "Note",
          createdAt: "2026-08-11T08:00:00.000Z",
          updatedAt: "2026-08-11T08:00:00.000Z",
          canEdit: false,
          canDelete: false,
        },
      ]).then((items) => items[0]!),
    ]);
    expect(book).toEqual({ id: "TBook1", name: "Short ID test", description: null, createdAt: null, updatedAt: null });
    expect({
      contactId: contact.id,
      contactBookId: contact.bookId,
      tagId: tag.id,
      tagBookId: tag.bookId,
      noteId: note.id,
      noteContactId: note.contactId,
    }).toEqual({
      contactId: "TCont1",
      contactBookId: "TBook1",
      tagId: "TTag01",
      tagBookId: "TBook1",
      noteId: "TNote1",
      noteContactId: "TCont1",
    });
    expect(JSON.stringify({ book, contact, tag, note })).not.toContain(bookId);
    expect(JSON.stringify({ book, contact, tag, note })).not.toContain(contactId);
  });
});
