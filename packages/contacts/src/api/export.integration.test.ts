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

// One more than paginate()'s 1,000 cap, so a clamped page loses the last contact.
const CONTACT_COUNT = 1001;

const bookWithContacts = async () => {
  const book = { id: crypto.randomUUID(), shortId: newShortId() };
  await sql`INSERT INTO contacts.books (id, short_id, name) VALUES (${book.id}::uuid, ${book.shortId}, 'Export test')`;
  created.books.push(book.id);
  // Two characters per run plus a four-digit number keep the six-character short IDs unique.
  const prefix = newShortId().slice(0, 2);
  await sql`
    INSERT INTO contacts.contacts (book_id, short_id, first_name, last_name)
    SELECT ${book.id}::uuid, ${prefix} || lpad(g::text, 4, '0'), 'Person', 'Number ' || g
    FROM generate_series(1, ${CONTACT_COUNT}) AS g`;
  return book;
};

const manager = async (bookId: string) => {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, admin)
    VALUES (${`contacts-export-${crypto.randomUUID()}`}, 'local', 'user', 'Export test', false) RETURNING id`;
  created.users.push(user!.id);
  const [access] = await sql<
    { id: string }[]
  >`INSERT INTO auth.access (user_id, permission) VALUES (${user!.id}::uuid, 'admin') RETURNING id`;
  await sql`INSERT INTO contacts.book_access (book_id, access_id) VALUES (${bookId}::uuid, ${access!.id}::uuid)`;
  return { cookie: `session_token=${await createTestSession(user!.id)}` };
};

const download = (path: string, user: { cookie: string }) =>
  contactsApi.request(path, { headers: { cookie: user.cookie, "x-forwarded-for": uniqueCallerAddress(), "accept-language": "en" } });

suite("Contacts book export (#1241)", () => {
  afterEach(async () => {
    for (const id of created.books.splice(0)) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'contacts' AND ordering_key = ${id}`;
      await sql`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM contacts.book_access WHERE book_id = ${id}::uuid)`;
      await sql`DELETE FROM contacts.books WHERE id = ${id}::uuid`;
    }
    for (const id of created.users.splice(0)) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("CSV and vCard exports contain every contact of a book with more than 1,000 contacts", async () => {
    const book = await bookWithContacts();
    const user = await manager(book.id);

    const csv = await download(`/books/${book.shortId}/export.csv`, user);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const rows = (await csv.text()).split("\r\n");
    expect(rows.pop()).toBe("");
    expect(rows[0]).toStartWith("First Name,Last Name,");
    expect(rows.filter((row) => row.startsWith("First Name,"))).toHaveLength(1);
    expect(rows).toHaveLength(CONTACT_COUNT + 1);
    expect(new Set(rows.slice(1)).size).toBe(CONTACT_COUNT);

    const vcf = await download(`/books/${book.shortId}/export.vcf`, user);
    expect(vcf.status).toBe(200);
    expect(vcf.headers.get("content-type")).toBe("text/vcard; charset=utf-8");
    const text = await vcf.text();
    expect(text.match(/^BEGIN:VCARD\r$/gm)).toHaveLength(CONTACT_COUNT);
    expect(text.match(/^END:VCARD\r$/gm)).toHaveLength(CONTACT_COUNT);
    expect(new Set(text.match(/^FN:.*$/gm)).size).toBe(CONTACT_COUNT);
    expect(text.endsWith("END:VCARD\r\n")).toBe(true);
  });
});
