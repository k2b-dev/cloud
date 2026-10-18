import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { accounts, serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import type { Result } from "@k2b/stdlib";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { newShortId } from "../lib/short-id";
import { type BookCaller, contactsService } from ".";

const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(30_000);
const timestamp = "2026-01-01T00:00:00.000Z";
const marker = `service-authorization-${crypto.randomUUID()}`;
const userIds: string[] = [];
const bookIds: string[] = [];
const accountIds: string[] = [];
const accessIds: string[] = [];
const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};

const person = async (name: string, admin = false): Promise<BookCaller> => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, admin)
    VALUES (${id}::uuid, ${`${marker}-${name}`}, 'local', 'user', ${name}, ${admin})`;
  userIds.push(id);
  const user = await accounts.users.get({ id });
  if (!user) throw new Error("Missing fixture user");
  return { actor: { kind: "user", user }, accessSubject: { type: "user", userId: id } };
};

const grant = async (bookId: string, caller: BookCaller, permission: "read" | "write" | "admin") => {
  const subject = caller.accessSubject;
  const [row] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, service_account_id, permission)
    VALUES (${subject.type === "user" ? subject.userId : null}::uuid,
      ${subject.type === "service_account" ? subject.serviceAccountId : null}::uuid, ${permission}::auth.permission_level) RETURNING id`;
  if (!row) throw new Error("Missing fixture grant");
  accessIds.push(row.id);
  await sql`INSERT INTO contacts.book_access (book_id, access_id) VALUES (${bookId}::uuid, ${row.id}::uuid)`;
};

const account = async (kind: "agent" | "standalone" | "resource_bound", resourceId: string | null = null): Promise<BookCaller> => {
  const [row] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
    VALUES (${`${marker}-${kind}`}, ${kind}, ${resourceId ? "contacts" : null},
      ${resourceId ? "contact_book" : null}, ${resourceId}) RETURNING id`;
  if (!row) throw new Error("Missing fixture account");
  accountIds.push(row.id);
  const serviceAccount = await serviceAccounts.get({ id: row.id });
  if (!serviceAccount) throw new Error("Missing fixture account");
  return {
    actor: { kind: "service_account", serviceAccount, delegatedUser: null, scopes: ["read"] },
    accessSubject: { type: "service_account", serviceAccountId: row.id },
  };
};

const scoped = (caller: BookCaller, scopes: string[]): BookCaller => {
  if (caller.actor.kind !== "service_account") throw new Error("Expected fixture account");
  return { ...caller, actor: { ...caller.actor, scopes } };
};

type Fixture = { bookId: string; targetBookId: string; contactId: string; otherContactId: string; tagId: string };
type Operation = {
  name: string;
  level: "read" | "write" | "admin";
  run: (caller: BookCaller, fixture: Fixture) => Promise<Result<unknown>>;
};
const operations: Operation[] = [
  { name: "book.get", level: "read", run: (caller, f) => contactsService.book.get({ ...caller, id: f.bookId }) },
  {
    name: "book.update",
    level: "admin",
    run: (caller, f) => contactsService.book.update({ ...caller, id: f.bookId, data: { description: marker } }),
  },
  { name: "book.remove", level: "admin", run: (caller, f) => contactsService.book.remove({ ...caller, id: f.bookId }) },
  { name: "contact.list", level: "read", run: (caller, f) => contactsService.contact.list({ ...caller, bookId: f.bookId }) },
  { name: "contact.get", level: "read", run: (caller, f) => contactsService.contact.get({ ...caller, bookId: f.bookId, id: f.contactId }) },
  {
    name: "contact.getMany",
    level: "read",
    run: (caller, f) => contactsService.contact.getMany({ ...caller, bookId: f.bookId, ids: [f.contactId] }),
  },
  {
    name: "contact.tree",
    level: "read",
    run: (caller, f) => contactsService.contact.tree({ ...caller, bookId: f.bookId, id: f.contactId }),
  },
  {
    name: "contact.create",
    level: "write",
    run: (caller, f) => contactsService.contact.create({ ...caller, bookId: f.bookId, data: { firstName: marker } }),
  },
  {
    name: "contact.createIdempotent",
    level: "write",
    run: (caller, f) =>
      contactsService.contact.createIdempotent({
        ...caller,
        bookId: f.bookId,
        data: { firstName: marker },
        actorKey: marker,
        actionId: "contacts.contact.create",
        idempotencyKeyHash: crypto.randomUUID(),
        requestHash: marker,
      }),
  },
  {
    name: "contact.update",
    level: "write",
    run: (caller, f) => contactsService.contact.update({ ...caller, bookId: f.bookId, id: f.contactId, data: { firstName: marker } }),
  },
  {
    name: "contact.remove",
    level: "write",
    run: (caller, f) => contactsService.contact.remove({ ...caller, bookId: f.bookId, id: f.contactId }),
  },
  {
    name: "contact.move",
    level: "write",
    run: (caller, f) => contactsService.contact.move({ ...caller, sourceBookId: f.bookId, targetBookId: f.targetBookId, id: f.contactId }),
  },
  { name: "contact.exportPages", level: "admin", run: (caller, f) => contactsService.contact.exportPages({ ...caller, bookId: f.bookId }) },
  {
    name: "contact.bulk.addTags",
    level: "write",
    run: (caller, f) => contactsService.contact.bulk.addTags({ ...caller, bookId: f.bookId, ids: [f.contactId], tagIds: [f.tagId] }),
  },
  {
    name: "contact.bulk.remove",
    level: "write",
    run: (caller, f) => contactsService.contact.bulk.remove({ ...caller, bookId: f.bookId, ids: [f.contactId] }),
  },
  {
    name: "contact.bulk.move",
    level: "write",
    run: (caller, f) =>
      contactsService.contact.bulk.move({ ...caller, sourceBookId: f.bookId, targetBookId: f.targetBookId, ids: [f.contactId] }),
  },
  {
    name: "contact.duplicates.list",
    level: "write",
    run: (caller, f) => contactsService.contact.duplicates.list({ ...caller, bookId: f.bookId }),
  },
  {
    name: "contact.duplicates.merge",
    level: "write",
    run: (caller, f) =>
      contactsService.contact.duplicates.merge({
        ...caller,
        bookId: f.bookId,
        keepId: f.contactId,
        removeId: f.otherContactId,
        keepUpdatedAt: timestamp,
        removeUpdatedAt: timestamp,
      }),
  },
];
const denied = (result: Result<unknown>, code: "FORBIDDEN" | "NOT_FOUND") => {
  expect(result).toMatchObject({ ok: false, error: { code, message: code === "FORBIDDEN" ? "Access denied" : "Book not found" } });
};

suite("Contacts service authorization (#1234 slice 2)", () => {
  let stranger: BookCaller;
  let cloudAdmin: BookCaller;
  let reader: BookCaller;
  let writer: BookCaller;
  let bookAdmin: BookCaller;
  let sourceWriter: BookCaller;
  let fixture: Fixture;

  const book = async () => {
    const id = crypto.randomUUID();
    await sql`INSERT INTO contacts.books (id, short_id, name) VALUES (${id}::uuid, ${newShortId()}, ${marker})`;
    bookIds.push(id);
    await grant(id, reader, "read");
    await grant(id, writer, "write");
    await grant(id, bookAdmin, "admin");
    return id;
  };
  const makeFixture = async (): Promise<Fixture> => {
    const bookId = await book();
    const targetBookId = await book();
    const contactId = crypto.randomUUID();
    const otherContactId = crypto.randomUUID();
    const tagId = crypto.randomUUID();
    const targetContactId = crypto.randomUUID();
    await sql`INSERT INTO contacts.contacts (id, short_id, book_id, first_name, updated_at) VALUES
      (${contactId}::uuid, ${newShortId()}, ${bookId}::uuid, ${marker}, ${timestamp}::timestamptz),
      (${otherContactId}::uuid, ${newShortId()}, ${bookId}::uuid, ${marker}, ${timestamp}::timestamptz),
      (${targetContactId}::uuid, ${newShortId()}, ${targetBookId}::uuid, ${marker}, ${timestamp}::timestamptz)`;
    await sql`INSERT INTO contacts.contact_emails (contact_id, email, position) VALUES
      (${contactId}::uuid, ${`${marker}@example.test`}, 0),
      (${targetContactId}::uuid, ${`${marker}@example.test`}, 0)`;
    await sql`INSERT INTO contacts.tags (id, short_id, book_id, name, color)
      VALUES (${tagId}::uuid, ${newShortId()}, ${bookId}::uuid, ${marker}, '#123456')`;
    return { bookId, targetBookId, contactId, otherContactId, tagId };
  };

  beforeAll(async () => {
    stranger = await person("stranger");
    cloudAdmin = await person("Cloud admin", true);
    reader = await person("reader");
    writer = await person("writer");
    bookAdmin = await person("book admin");
    sourceWriter = await person("source writer");
    fixture = await makeFixture();
    await grant(fixture.bookId, sourceWriter, "write");
  });

  afterAll(async () => {
    await sql`DELETE FROM contacts.capability_action_results WHERE actor_key = ${marker}`;
    if (bookIds.length) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'contacts' AND ordering_key IN ${sql(bookIds)}`;
      await sql`DELETE FROM contacts.books WHERE id IN ${sql(bookIds)}`;
    }
    if (accessIds.length) await sql`DELETE FROM auth.access WHERE id IN ${sql(accessIds)}`;
    if (accountIds.length) {
      await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id IN ${sql(accountIds)}`;
      await sql`DELETE FROM auth.service_accounts WHERE id IN ${sql(accountIds)}`;
    }
    if (userIds.length) await sql`DELETE FROM auth.users WHERE id IN ${sql(userIds)}`;
  });

  for (const operation of operations) {
    test(`${operation.name} checks existence, grants, and the required ${operation.level} level before domain work`, async () => {
      for (const caller of [stranger, cloudAdmin]) {
        denied(await operation.run(caller, fixture), "FORBIDDEN");
        denied(await operation.run(caller, { ...fixture, bookId: crypto.randomUUID() }), "NOT_FOUND");
      }
      if (operation.level !== "read") denied(await operation.run(reader, fixture), "FORBIDDEN");
      if (operation.level === "admin") denied(await operation.run(writer, fixture), "FORBIDDEN");
      const fresh = await makeFixture();
      const caller = operation.level === "read" ? reader : operation.level === "write" ? writer : bookAdmin;
      expect((await operation.run(caller, fresh)).ok).toBeTrue();
    });
  }

  for (const move of [contactsService.contact.move, contactsService.contact.bulk.move]) {
    test(`${move === contactsService.contact.move ? "move" : "bulk.move"} checks source before target and requires write on both`, async () => {
      const fresh = await makeFixture();
      await grant(fresh.bookId, sourceWriter, "write");
      const config = {
        ...sourceWriter,
        sourceBookId: fresh.bookId,
        targetBookId: fresh.targetBookId,
        id: fresh.contactId,
        ids: [fresh.contactId],
      };
      denied(await move(config), "FORBIDDEN");
      denied(await move({ ...config, ...stranger, targetBookId: crypto.randomUUID() }), "FORBIDDEN");
      denied(await move({ ...config, sourceBookId: crypto.randomUUID(), targetBookId: crypto.randomUUID() }), "NOT_FOUND");
      denied(await move({ ...config, targetBookId: crypto.randomUUID() }), "NOT_FOUND");
      await grant(fresh.targetBookId, sourceWriter, "write");
      expect((await move(config)).ok).toBeTrue();
    });
  }

  test("authorized nullable reads and export pages preserve their payloads", async () => {
    expect(unwrap(await contactsService.contact.get({ ...reader, bookId: fixture.bookId, id: crypto.randomUUID() }))).toBeNull();
    expect(unwrap(await contactsService.contact.tree({ ...reader, bookId: fixture.bookId, id: crypto.randomUUID() }))).toBeNull();
    const exported = unwrap(await contactsService.contact.exportPages({ ...bookAdmin, bookId: fixture.bookId }));
    expect(exported.book.id).toBe(fixture.bookId);
    const pages = exported.pages(new AbortController().signal);
    const ids: string[] = [];
    for await (const page of pages) ids.push(...page.map((contact) => contact.id));
    expect(ids.sort()).toEqual([fixture.contactId, fixture.otherContactId].sort());
  });

  const collectionBooks = async (caller: BookCaller) => {
    const listed = unwrap(await contactsService.book.list({ ...caller, filter: { query: marker } }));
    const page = unwrap(await contactsService.book.listPage({ ...caller, filter: { query: marker } }));
    const ids = unwrap(await contactsService.book.readableIds(caller)).filter((id) => bookIds.includes(id));
    const named = unwrap(await contactsService.book.findReadableByName({ ...caller, name: marker, limit: 100 }));
    const contacts = unwrap(await contactsService.contact.search({ ...caller, filter: { query: marker } }));
    const lookup = unwrap(
      await contactsService.lookup.resolveContactsByEmail({ ...caller, input: { emails: [`${marker}@example.test`], limit: 100 } }),
    );
    return { listed, page, ids, named, contacts, lookup };
  };

  test("collection reads derive user, agent, standalone, resource-bound, and delegated scopes", async () => {
    for (const caller of [stranger, cloudAdmin]) {
      const results = await collectionBooks(caller);
      expect(results.listed.items).toEqual([]);
      expect(results.listed.total).toBe(0);
      expect(results.page.items).toEqual([]);
      expect(results.page.total).toBe(0);
      expect(results.ids).toEqual([]);
      expect(results.named).toEqual([]);
      expect(results.contacts.items).toEqual([]);
      expect(results.contacts.total).toBe(0);
      expect(results.lookup.items).toEqual([]);
    }
    const limited = await person("limited reader");
    await grant(fixture.bookId, limited, "read");
    const agent = await account("agent");
    const standalone = await account("standalone");
    const bound = await account("resource_bound", fixture.bookId);
    for (const caller of [agent, standalone, bound]) {
      await grant(fixture.bookId, caller, "read");
      await grant(fixture.targetBookId, caller, "read");
    }
    const limitedUser = limited.actor.kind === "user" ? limited.actor.user : null;
    if (!limitedUser) throw new Error("Expected fixture user");
    const delegatedAccount = unwrap(await serviceAccountCredentials.getOrCreateUserDelegatedServiceAccount({ userId: limitedUser.id }));
    accountIds.push(delegatedAccount.id);
    const delegated: BookCaller = {
      actor: { kind: "service_account", serviceAccount: delegatedAccount, delegatedUser: limitedUser, scopes: ["openid"] },
      accessSubject: { type: "user", userId: limitedUser.id, delegatedByServiceAccountId: delegatedAccount.id },
    };
    for (const caller of [limited, bound, delegated]) {
      const results = await collectionBooks(caller);
      expect(results.listed.items.map((book) => book.id)).toEqual([fixture.bookId]);
      expect(results.listed.total).toBe(1);
      expect(results.page.items.map((book) => book.id)).toEqual([fixture.bookId]);
      expect(results.page.total).toBe(1);
      expect(results.ids).toEqual([fixture.bookId]);
      expect(results.named.map((book) => book.id)).toEqual([fixture.bookId]);
      expect(new Set(results.contacts.items.map((contact) => contact.bookId))).toEqual(new Set([fixture.bookId]));
      expect(results.contacts.total).toBe(2);
      expect(results.lookup.items.map((match) => match.contactId)).toEqual([fixture.contactId]);
    }
    for (const caller of [agent, standalone]) {
      const results = await collectionBooks(caller);
      expect(results.ids.sort()).toEqual([fixture.bookId, fixture.targetBookId].sort());
      expect(results.listed.total).toBe(2);
      expect(results.page.total).toBe(2);
      expect(results.contacts.total).toBe(3);
      expect(new Set(results.lookup.items.map((match) => match.bookId))).toEqual(new Set([fixture.bookId, fixture.targetBookId]));
      const unscoped = scoped(caller, ["openid"]);
      for (const result of [
        await contactsService.book.list(unscoped),
        await contactsService.book.listPage(unscoped),
        await contactsService.book.readableIds(unscoped),
        await contactsService.book.findReadableByName({ ...unscoped, name: marker, limit: 100 }),
        await contactsService.contact.search(unscoped),
        await contactsService.lookup.resolveContactsByEmail({ ...unscoped, input: { emails: [`${marker}@example.test`], limit: 100 } }),
      ])
        denied(result, "FORBIDDEN");
    }
  });
});
