import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { create, list, remove, update } from "./notes";

const suite = databaseSuite();

suite("Contacts note mutation window", () => {
  let bookId = "";
  let contactId = "";
  let authorId = "";
  let otherUserId = "";

  beforeAll(async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const users = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES
        (${`contacts-note-author-${suffix}`}, 'local', 'user', 'Note Author', false),
        (${`contacts-note-other-${suffix}`}, 'local', 'user', 'Other User', false)
      RETURNING id
    `;
    authorId = users[0]!.id;
    otherUserId = users[1]!.id;
    const [book] = await sql<{ id: string }[]>`
      INSERT INTO contacts.books (short_id, name)
      VALUES (${newShortId()}, ${`Note policy ${suffix}`})
      RETURNING id
    `;
    bookId = book!.id;
    const [contact] = await sql<{ id: string }[]>`
      INSERT INTO contacts.contacts (short_id, book_id, first_name)
      VALUES (${newShortId()}, ${bookId}::uuid, 'Policy')
      RETURNING id
    `;
    contactId = contact!.id;
  });

  afterAll(async () => {
    if (bookId) await sql`DELETE FROM contacts.books WHERE id = ${bookId}::uuid`;
    if (authorId && otherUserId) await sql`DELETE FROM auth.users WHERE id IN (${authorId}::uuid, ${otherUserId}::uuid)`;
  });

  test("allows only the author to edit and delete during the first 10 minutes", async () => {
    const created = await create({
      bookId,
      contactId,
      authorUserId: authorId,
      authorDisplayName: "Note Author",
      data: { content: "Initial context" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data).toMatchObject({ canEdit: true, canDelete: true });

    const otherView = await list({ bookId, contactId, viewerUserId: otherUserId });
    expect(otherView[0]).toMatchObject({ canEdit: false, canDelete: false });
    expect(
      await update({
        bookId,
        contactId,
        noteId: created.data.id,
        authorUserId: otherUserId,
        data: { content: "Overwrite" },
      }),
    ).toMatchObject({ ok: false, error: { status: 403 } });

    const edited = await update({
      bookId,
      contactId,
      noteId: created.data.id,
      authorUserId: authorId,
      data: { content: "Corrected context" },
    });
    expect(edited.ok).toBe(true);

    await sql`
      UPDATE contacts.contact_notes
      SET created_at = now() - interval '11 minutes'
      WHERE id = ${created.data.id}::uuid
    `;
    const expiredView = await list({ bookId, contactId, viewerUserId: authorId });
    expect(expiredView[0]).toMatchObject({ canEdit: false, canDelete: false });
    expect(
      await update({
        bookId,
        contactId,
        noteId: created.data.id,
        authorUserId: authorId,
        data: { content: "Too late" },
      }),
    ).toMatchObject({ ok: false, error: { status: 403 } });
    expect(await remove({ bookId, contactId, noteId: created.data.id, authorUserId: authorId })).toMatchObject({
      ok: false,
      error: { status: 403 },
    });

    const removable = await create({
      bookId,
      contactId,
      authorUserId: authorId,
      authorDisplayName: "Note Author",
      data: { content: "Remove promptly" },
    });
    expect(removable.ok).toBe(true);
    if (removable.ok) {
      expect(await remove({ bookId, contactId, noteId: removable.data.id, authorUserId: authorId })).toEqual({
        ok: true,
        data: undefined,
      });
    }
  });
});
