import { expect, setDefaultTimeout, test } from "bun:test";
import { accounts } from "@k2b/cloud/services";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { newShortId } from "../lib/short-id";
import { contactsService } from ".";

const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(30_000);

// Postgres pages small tied sets with a top-N heap sort that reorders equal rows between offsets; from five
// tied books on, a list without a unique tie-breaker repeats some books and skips others.
const bookCount = 6;

suite("Contacts book ordering (SRV-09)", () => {
  test("pages books with the same name and creation time once each, by ascending id", async () => {
    const ids = Array.from({ length: bookCount }, () => crypto.randomUUID()).sort();
    const marker = crypto.randomUUID();
    const name = `Same ${marker}`;
    const accessIds: string[] = [];
    let userId: string | undefined;

    try {
      const books = await sql.begin(async (tx) => {
        // One transaction gives every book the same created_at; descending ids make insertion order differ from id order.
        const books: { created_at: Date }[] = [];
        for (const id of ids.toReversed()) {
          books.push(
            ...(await tx<{ created_at: Date }[]>`
              INSERT INTO contacts.books (id, short_id, name) VALUES (${id}::uuid, ${newShortId()}, ${name}) RETURNING created_at
            `),
          );
        }
        const [user] = await tx<{ id: string }[]>`
          INSERT INTO auth.users (uid, provider, profile, display_name, admin)
          VALUES (${`contacts-book-order-${crypto.randomUUID()}`}, 'local', 'user', 'Book order test', true)
          RETURNING id
        `;
        userId = user!.id;
        for (const bookId of ids) {
          const [access] = await tx<{ id: string }[]>`
            INSERT INTO auth.access (user_id, permission)
            VALUES (${userId}::uuid, 'read') RETURNING id
          `;
          accessIds.push(access!.id);
          await tx`INSERT INTO contacts.book_access (book_id, access_id) VALUES (${bookId}::uuid, ${access!.id}::uuid)`;
        }
        return books;
      });

      expect(books).toHaveLength(bookCount);
      expect(new Set(books.map((book) => book.created_at.getTime())).size).toBe(1);

      const callerUser = await accounts.users.get({ id: userId! });
      if (!callerUser) throw new Error("Missing fixture user");
      const adminIds: string[] = [];
      const readableIds: string[] = [];
      for (let page = 1; page <= bookCount; page++) {
        const adminResult = await contactsService.book.admin.list({
          actor: { kind: "user", user: callerUser },
          pagination: { page, perPage: 1 },
          filter: { query: marker },
        });
        if (!adminResult.ok) throw new Error(adminResult.error.message);
        const admin = adminResult.data;
        expect(admin.total).toBe(bookCount);
        adminIds.push(...admin.items.map((book) => book.id));

        const result = await contactsService.book.list({
          actor: { kind: "user", user: callerUser },
          accessSubject: { type: "user", userId: userId! },
          pagination: { page, perPage: 1 },
          // Books shared with every signed-in person elsewhere in the test database stay out of the count.
          filter: { query: marker },
        });
        if (!result.ok) throw new Error(result.error.message);
        const readable = result.data;
        expect(readable.total).toBe(bookCount);
        readableIds.push(...readable.items.map((book) => book.id));
      }
      expect(adminIds).toEqual(ids);
      expect(readableIds).toEqual(ids);
    } finally {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM contacts.book_access WHERE book_id IN ${tx(ids)}`;
        if (accessIds.length > 0) await tx`DELETE FROM auth.access WHERE id IN ${tx(accessIds)}`;
        await tx`DELETE FROM contacts.books WHERE id IN ${tx(ids)}`;
        if (userId) await tx`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
      });
    }
  });
});
