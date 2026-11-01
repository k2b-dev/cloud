import { sql } from "@k2b/cloud";
import { toPgUuidArray } from "./shared";
import type { Contact, ContactFavorite } from "./types";

type FavoriteRow = {
  book_id: string;
  contact_id: string;
  created_at: Date;
};

export const favoriteKey = (bookId: string, contactId: string): string => `${bookId}:${contactId}`;

export const list = async (userId: string): Promise<ContactFavorite[]> => {
  const rows = await sql<FavoriteRow[]>`
    SELECT favorite.book_id, favorite.contact_id, favorite.created_at
    FROM contacts.contact_favorites favorite
    WHERE user_id = ${userId}::uuid
      AND EXISTS (
        SELECT 1
        FROM contacts.contacts contact
        WHERE contact.id = favorite.contact_id AND contact.book_id::text = favorite.book_id
      )
    ORDER BY created_at DESC
  `;
  return rows.map((row) => ({
    bookId: row.book_id,
    contactId: row.contact_id,
    createdAt: row.created_at.toISOString(),
  }));
};

/** Returns favorite keys only for contacts already selected by a bounded query. */
export const listKeysForContacts = async (config: {
  userId: string;
  contacts: Array<Pick<Contact, "bookId" | "id">>;
}): Promise<string[]> => {
  if (config.contacts.length === 0) return [];
  const requested = new Set(config.contacts.map((contact) => favoriteKey(contact.bookId, contact.id)));
  const rows = await sql<Pick<FavoriteRow, "book_id" | "contact_id">[]>`
    SELECT book_id, contact_id
    FROM contacts.contact_favorites
    WHERE user_id = ${config.userId}::uuid
      AND contact_id = ANY(${toPgUuidArray([...new Set(config.contacts.map((contact) => contact.id))])}::uuid[])
  `;
  return rows.map((row) => favoriteKey(row.book_id, row.contact_id)).filter((key) => requested.has(key));
};

export const has = async (config: { userId: string; bookId: string; contactId: string }): Promise<boolean> => {
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM contacts.contact_favorites
      WHERE user_id = ${config.userId}::uuid
        AND book_id = ${config.bookId}
        AND contact_id = ${config.contactId}::uuid
    ) AS "exists"
  `;
  return row?.exists ?? false;
};

export const set = async (config: { userId: string; bookId: string; contactId: string; favorite: boolean }): Promise<void> => {
  if (config.favorite) {
    await sql`
      INSERT INTO contacts.contact_favorites (user_id, book_id, contact_id)
      VALUES (${config.userId}::uuid, ${config.bookId}, ${config.contactId}::uuid)
      ON CONFLICT (user_id, book_id, contact_id) DO NOTHING
    `;
    return;
  }
  await sql`
    DELETE FROM contacts.contact_favorites
    WHERE user_id = ${config.userId}::uuid
      AND book_id = ${config.bookId}
      AND contact_id = ${config.contactId}::uuid
  `;
};

export const removeForContacts = async (bookId: string, contactIds: string[]): Promise<void> => {
  if (contactIds.length === 0) return;
  await sql`
    DELETE FROM contacts.contact_favorites
    WHERE book_id = ${bookId}
      AND contact_id = ANY(${toPgUuidArray(contactIds)}::uuid[])
  `;
};
