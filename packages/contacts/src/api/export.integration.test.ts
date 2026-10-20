import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { toPgTextArray } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
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
  const shortIds = Array.from({ length: CONTACT_COUNT }, () => testShortId());
  await sql`
    INSERT INTO contacts.contacts (book_id, short_id, first_name, last_name)
    SELECT ${book.id}::uuid, short_id, 'Person', 'Number ' || n
    FROM unnest(${toPgTextArray(shortIds)}::text[]) WITH ORDINALITY AS fixture(short_id, n)`;
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

  test("CSV export returns the documented authentication and book access errors (#1239)", async () => {
    const book = { id: crypto.randomUUID(), shortId: newShortId() };
    await sql`INSERT INTO contacts.books (id, short_id, name) VALUES (${book.id}::uuid, ${book.shortId}, 'Export access test')`;
    created.books.push(book.id);
    const grantedUser = await manager(book.id);
    const [userWithoutGrant] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`contacts-export-${crypto.randomUUID()}`}, 'local', 'user', 'Export access test', false) RETURNING id`;
    created.users.push(userWithoutGrant!.id);
    const cookie = `session_token=${await createTestSession(userWithoutGrant!.id)}`;

    const unauthenticated = await contactsApi.request(`/books/${book.shortId}/export.csv`, {
      headers: { "x-forwarded-for": uniqueCallerAddress(), "accept-language": "en" },
    });
    expect(unauthenticated.status).toBe(401);
    expect(ErrorResponseSchema.parse(await unauthenticated.json()).message).toBe("Authentication required");

    const forbidden = await download(`/books/${book.shortId}/export.csv`, { cookie });
    expect(forbidden.status).toBe(403);
    ErrorResponseSchema.parse(await forbidden.json());

    const missing = await download(`/books/${newShortId()}/export.csv`, grantedUser);
    expect(missing.status).toBe(404);
    ErrorResponseSchema.parse(await missing.json());
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
