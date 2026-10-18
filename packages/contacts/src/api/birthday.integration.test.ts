import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { newShortId } from "../lib/short-id";
import contactsApi from ".";

const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(60_000);
const created = { books: [] as string[], users: [] as string[] };

const book = async () => {
  const book = { id: crypto.randomUUID(), shortId: newShortId() };
  await sql`INSERT INTO contacts.books (id, short_id, name) VALUES (${book.id}::uuid, ${book.shortId}, 'Birthday test')`;
  created.books.push(book.id);
  return book;
};

const manager = async (bookId: string) => {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, admin)
    VALUES (${`contacts-birthday-${crypto.randomUUID()}`}, 'local', 'user', 'Birthday test', false) RETURNING id`;
  created.users.push(user!.id);
  const [access] = await sql<
    { id: string }[]
  >`INSERT INTO auth.access (user_id, permission) VALUES (${user!.id}::uuid, 'admin') RETURNING id`;
  await sql`INSERT INTO contacts.book_access (book_id, access_id) VALUES (${bookId}::uuid, ${access!.id}::uuid)`;
  return { cookie: `session_token=${await createTestSession(user!.id)}` };
};

suite("Contacts birthday date-only round trip (#1232)", () => {
  afterEach(async () => {
    for (const id of created.books.splice(0)) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'contacts' AND ordering_key = ${id}`;
      await sql`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM contacts.book_access WHERE book_id = ${id}::uuid)`;
      await sql`DELETE FROM contacts.books WHERE id = ${id}::uuid`;
    }
    for (const id of created.users.splice(0)) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("preserves the birthday when created and read in different time zones", async () => {
    const contactBook = await book();
    const user = await manager(contactBook.id);
    const previousTZ = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      const response = await contactsApi.request(`/books/${contactBook.shortId}/contacts`, {
        method: "POST",
        headers: {
          cookie: user.cookie,
          "content-type": "application/json",
          "x-forwarded-for": uniqueCallerAddress(),
          "accept-language": "en",
        },
        body: JSON.stringify({ firstName: "Birthday", birthday: "1990-05-12" }),
      });
      expect(response.status).toBe(200);
      const saved: { id: string; birthday: string } = await response.json();
      expect(saved.birthday).toBe("1990-05-12");

      for (const timeZone of ["America/New_York", "Europe/Berlin"]) {
        process.env.TZ = timeZone;
        const read = await contactsApi.request(`/books/${contactBook.shortId}/contacts/${saved.id}`, {
          headers: { cookie: user.cookie, "x-forwarded-for": uniqueCallerAddress(), "accept-language": "en" },
        });
        expect(read.status).toBe(200);
        expect(await read.json()).toMatchObject({ birthday: "1990-05-12" });
      }
    } finally {
      if (previousTZ === undefined) delete process.env.TZ;
      else process.env.TZ = previousTZ;
    }
  });
});
