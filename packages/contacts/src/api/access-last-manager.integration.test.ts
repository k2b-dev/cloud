import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { ensureManagerRemains } from "@k2b/cloud/server";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { inLockOrder } from "../../../../scripts/fixtures/lock-order";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { newShortId } from "../lib/short-id";
import contactsApi from ".";

const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(30_000);
const created = { books: [] as string[], users: [] as string[], accounts: [] as string[] };

const book = async () => {
  const value = { id: crypto.randomUUID(), shortId: newShortId() };
  await sql`INSERT INTO contacts.books (id, short_id, name) VALUES (${value.id}::uuid, ${value.shortId}, 'Manager test')`;
  created.books.push(value.id);
  return value;
};

const person = async (admin = false) => {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, admin)
    VALUES (${`contacts-manager-${crypto.randomUUID()}`}, 'local', 'user', 'Manager test', ${admin}) RETURNING id`;
  created.users.push(user!.id);
  return { id: user!.id, cookie: `session_token=${await createTestSession(user!.id)}` };
};

const account = async (bookId: string, kind: "resource_bound" | "agent") => {
  const [row] =
    kind === "resource_bound"
      ? await sql<{ id: string }[]>`
        INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
        VALUES ('Book key', 'resource_bound', 'contacts', 'contact_book', ${bookId}) RETURNING id`
      : await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind) VALUES ('Book agent', 'agent') RETURNING id`;
  created.accounts.push(row!.id);
  return row!.id;
};

const grant = async (bookId: string, principal: { userId: string } | { serviceAccountId: string }) => {
  const [row] =
    "userId" in principal
      ? await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission) VALUES (${principal.userId}::uuid, 'admin') RETURNING id`
      : await sql<
          { id: string }[]
        >`INSERT INTO auth.access (service_account_id, permission) VALUES (${principal.serviceAccountId}::uuid, 'admin') RETURNING id`;
  await sql`INSERT INTO contacts.book_access (book_id, access_id) VALUES (${bookId}::uuid, ${row!.id}::uuid)`;
  return row!.id;
};

const request = async (path: string, user: { cookie: string }, method: string, body?: unknown, locale = "en") =>
  contactsApi.request(path, {
    method,
    headers: {
      cookie: user.cookie,
      "x-forwarded-for": uniqueCallerAddress(),
      "accept-language": locale,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// Holding the grants too makes the old ACL-only lock queue behind the fixture.
const holdBook = (bookId: string) => async (holder: typeof sql) => {
  await holder`SELECT id FROM contacts.books WHERE id = ${bookId}::uuid FOR UPDATE`;
  await holder`SELECT a.id FROM contacts.book_access ba JOIN auth.access a ON a.id = ba.access_id
    WHERE ba.book_id = ${bookId}::uuid FOR UPDATE OF a`;
};

const permissions = (bookId: string) => sql<{ id: string; permission: string }[]>`
  SELECT a.id, a.permission FROM contacts.book_access ba JOIN auth.access a ON a.id = ba.access_id WHERE ba.book_id = ${bookId}::uuid`;

const accessChanges = async (bookId: string) => {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM events.outbox
    WHERE app_id = 'contacts' AND ordering_key = ${bookId} AND payload->'d'->>'type' = 'access.changed'`;
  return row!.count;
};

const expectLastManager = async (response: Response) => {
  expect(response.status).toBe(409);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ code: "LAST_MANAGER" });
  return body;
};

suite("Contacts keeps its last manager (ACC-06)", () => {
  afterEach(async () => {
    for (const id of created.books.splice(0)) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'contacts' AND ordering_key = ${id}`;
      await sql`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM contacts.book_access WHERE book_id = ${id}::uuid)`;
      await sql`DELETE FROM contacts.books WHERE id = ${id}::uuid`;
    }
    for (const id of created.accounts.splice(0)) await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    for (const id of created.users.splice(0)) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("a book-bound key cannot replace its last person; refusals preserve the grant, localized message, and outbox", async () => {
    const target = await book();
    const a = await person();
    const own = await grant(target.id, { userId: a.id });
    await grant(target.id, { serviceAccountId: await account(target.id, "resource_bound") });
    const path = `/books/${target.shortId}/access/${own}`;

    for (const locale of ["en", "de"]) {
      const expected = ensureManagerRemains({
        before: [{ principal: { type: "user", userId: a.id }, permission: "admin" }],
        after: [],
        locale,
      });
      if (expected.ok) throw new Error("The fixture must remove the last manager");
      for (const method of ["DELETE", "PATCH"]) {
        const response = await request(path, a, method, method === "PATCH" ? { permission: "read" } : undefined, locale);
        expect(await expectLastManager(response)).toMatchObject({ message: expected.error.message });
        expect((await permissions(target.id)).find((entry) => entry.id === own)?.permission).toBe("admin");
        expect(await accessChanges(target.id)).toBe(0);
      }
    }
  });

  test("two managers lowering their own grants concurrently leave exactly one manager", async () => {
    const target = await book();
    const a = await person();
    const b = await person();
    const ownA = await grant(target.id, { userId: a.id });
    const ownB = await grant(target.id, { userId: b.id });
    const results = await inLockOrder(holdBook(target.id), [
      () => request(`/books/${target.shortId}/access/${ownA}`, a, "PATCH", { permission: "read" }),
      () => request(`/books/${target.shortId}/access/${ownB}`, b, "PATCH", { permission: "read" }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    await expectLastManager(results.find((response) => response.status === 409)!);
    expect((await permissions(target.id)).filter((entry) => entry.permission === "admin")).toHaveLength(1);
  });

  test("a manager lowered while waiting cannot change another manager's grant", async () => {
    const target = await book();
    const a = await person();
    const b = await person();
    const c = await person();
    await grant(target.id, { userId: a.id });
    const ownB = await grant(target.id, { userId: b.id });
    const ownC = await grant(target.id, { userId: c.id });
    const [first, stale] = await inLockOrder(holdBook(target.id), [
      () => request(`/books/${target.shortId}/access/${ownB}`, a, "PATCH", { permission: "read" }),
      () => request(`/books/${target.shortId}/access/${ownC}`, b, "PATCH", { permission: "read" }),
    ]);
    expect(first!.status).toBe(200);
    expect(stale!.status).toBe(403);
    const entries = await permissions(target.id);
    expect(entries.find((entry) => entry.id === ownB)?.permission).toBe("read");
    expect(entries.find((entry) => entry.id === ownC)?.permission).toBe("admin");
  });

  test("an agent can remain as manager when the person leaves, publishing one access change", async () => {
    const target = await book();
    const a = await person();
    const own = await grant(target.id, { userId: a.id });
    const agent = await grant(target.id, { serviceAccountId: await account(target.id, "agent") });
    const before = await accessChanges(target.id);
    expect((await request(`/books/${target.shortId}/access/${own}`, a, "DELETE")).status).toBe(200);
    expect(await permissions(target.id)).toEqual([{ id: agent, permission: "admin" }]);
    expect(await accessChanges(target.id)).toBe(before + 1);
  });

  test("a Cloud admin must grant a new manager before removing the last person", async () => {
    const target = await book();
    const admin = await person(true);
    const a = await person();
    const b = await person();
    const own = await grant(target.id, { userId: a.id });
    await grant(target.id, { serviceAccountId: await account(target.id, "resource_bound") });
    const path = `/admin/books/${target.shortId}/access`;
    await expectLastManager(await request(`${path}/${own}`, admin, "DELETE"));
    expect((await request(path, admin, "POST", { principal: { type: "user", userId: b.id }, permission: "admin" })).status).toBe(200);
    expect((await request(`${path}/${own}`, admin, "DELETE")).status).toBe(200);
  });
});
