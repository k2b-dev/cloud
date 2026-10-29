import { expect, setDefaultTimeout, test } from "bun:test";
import { serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { databaseSuite, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import "../../../../scripts/fixtures/authorization-preload";
import { contactsService } from "../service";
import contactsApi from ".";

const suite = databaseSuite();
setDefaultTimeout(30_000);

const insertAccount = async (name: string, bookId?: string) => {
  const [row] = bookId
    ? await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
        VALUES (${name}, 'resource_bound', 'contacts', 'contact_book', ${bookId}) RETURNING id`
    : await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind) VALUES (${name}, 'agent') RETURNING id`;
  return { id: row!.id, name };
};

const grant = async (bookId: string, serviceAccountId: string, permission: "read" | "write" | "admin") => {
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (service_account_id, permission) VALUES (${serviceAccountId}::uuid, ${permission}) RETURNING id`;
  await sql`INSERT INTO contacts.book_access (book_id, access_id) VALUES (${bookId}::uuid, ${access!.id}::uuid)`;
};

/** Calls the real Contacts API with a service-account credential carrying the given scopes. */
const apiAs = async (account: { id: string }, scopes: string[]) => {
  const created = await serviceAccountCredentials.createApiToken({
    serviceAccountId: account.id,
    name: `test ${scopes.join(" ")}`,
    scopes,
  });
  if (!created.ok) throw new Error(created.error.message);
  const authorization = `Bearer ${created.data.token}`;
  return (path: string, init?: { method?: string; body?: unknown }) =>
    contactsApi.request(path, {
      method: init?.method ?? "GET",
      headers: { authorization, ...(init?.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
};

const listedIds = async (response: Response) => ((await response.json()) as { data: { id: string }[] }).data.map((item) => item.id);

suite("Contacts REST access for standalone agents", () => {
  test("an agent reads and writes only inside its direct grant and within its scopes; resource-bound keys stay bound", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const granted = { id: crypto.randomUUID(), shortId: testShortId(), name: `Agent granted ${suffix}` };
    const other = { id: crypto.randomUUID(), shortId: testShortId(), name: `Agent other ${suffix}` };
    await sql`INSERT INTO contacts.books (id, short_id, name) VALUES
      (${granted.id}::uuid, ${granted.shortId}, ${granted.name}), (${other.id}::uuid, ${other.shortId}, ${other.name})`;
    const accountIds: string[] = [];
    try {
      const fixtureAccount = await insertAccount(`Fixture owner ${suffix}`);
      accountIds.push(fixtureAccount.id);
      await grant(granted.id, fixtureAccount.id, "admin");
      await grant(other.id, fixtureAccount.id, "admin");
      const fixtureActor = await serviceAccounts.get({ id: fixtureAccount.id });
      if (!fixtureActor) throw new Error("Missing fixture service account");
      const caller = {
        actor: { kind: "service_account" as const, serviceAccount: fixtureActor, delegatedUser: null, scopes: ["admin"] },
        accessSubject: { type: "service_account" as const, serviceAccountId: fixtureAccount.id },
      };
      const email = `ada.${suffix}@example.test`;
      const created = await contactsService.contact.create({
        ...caller,
        bookId: granted.id,
        data: { firstName: "Ada", lastName: `Example ${suffix}`, emails: [{ email }] },
      });
      if (!created.ok) throw new Error(created.error.message);
      const hidden = await contactsService.contact.create({
        ...caller,
        bookId: other.id,
        data: { firstName: "Grace", lastName: `Example ${suffix}` },
      });
      if (!hidden.ok) throw new Error(hidden.error.message);

      const agent = await insertAccount(`Agent ${suffix}`);
      const manager = await insertAccount(`Manager ${suffix}`);
      const stranger = await insertAccount(`Stranger ${suffix}`);
      const bound = await insertAccount(`Bound ${suffix}`, granted.id);
      accountIds.push(agent.id, manager.id, stranger.id, bound.id);
      await grant(granted.id, agent.id, "write");
      await grant(granted.id, manager.id, "admin");
      await grant(granted.id, bound.id, "read");
      await grant(other.id, bound.id, "read");

      // With a grant, an agent lists, searches, resolves, reads, and writes like a person with the same grant.
      const call = await apiAs(agent, ["openid", "read", "write"]);
      const books = await call("/books");
      expect(books.status).toBe(200);
      expect(await listedIds(books)).toEqual([granted.shortId]);
      const search = await call(`/search?q=${encodeURIComponent(suffix)}`);
      expect(search.status).toBe(200);
      expect((await search.json()) as { data: { firstName: string }[] }).toMatchObject({ data: [{ firstName: "Ada" }] });
      const byName = await call(`/resolve?book=${encodeURIComponent(granted.name)}`);
      expect(byName.status).toBe(200);
      expect(await byName.json()).toMatchObject({ book: { id: granted.shortId }, contact: null });
      const byEmail = await call(`/resolve?email=${encodeURIComponent(email)}`);
      expect(byEmail.status).toBe(200);
      expect(await byEmail.json()).toMatchObject({ book: { id: granted.shortId }, contact: { firstName: "Ada" } });
      expect((await call(`/books/${granted.shortId}/contacts`)).status).toBe(200);
      expect((await call(`/books/${other.shortId}`)).status).toBe(403);
      expect((await call(`/resolve?book=${encodeURIComponent(other.name)}`)).status).toBe(404);
      const written = await call(`/books/${granted.shortId}/contacts`, { method: "POST", body: { firstName: "Agent", lastName: suffix } });
      expect(written.status).toBe(200);

      // Scopes cap the grant: a read-only token reads but cannot write, and a token without `read` reaches nothing.
      const readOnly = await apiAs(agent, ["read"]);
      expect((await readOnly(`/books/${granted.shortId}`)).status).toBe(200);
      expect(
        (await readOnly(`/books/${granted.shortId}/contacts`, { method: "POST", body: { firstName: "No", lastName: suffix } })).status,
      ).toBe(403);
      const unscoped = await apiAs(agent, ["openid"]);
      expect((await unscoped("/books")).status).toBe(403);
      expect((await unscoped(`/books/${granted.shortId}`)).status).toBe(403);

      // Without a grant an agent sees nothing and cannot act.
      const denied = await apiAs(stranger, ["read", "write"]);
      expect(await listedIds(await denied("/books"))).toEqual([]);
      expect(await listedIds(await denied(`/search?q=${encodeURIComponent(suffix)}`))).toEqual([]);
      expect((await denied(`/books/${granted.shortId}`)).status).toBe(403);
      expect(
        (await denied(`/books/${granted.shortId}/contacts`, { method: "POST", body: { firstName: "No", lastName: suffix } })).status,
      ).toBe(403);

      // A resource-bound key keeps seeing only its bound book, even with a grant elsewhere.
      const boundCall = await apiAs(bound, ["read"]);
      expect(await listedIds(await boundCall("/books"))).toEqual([granted.shortId]);
      expect((await boundCall(`/books/${other.shortId}`)).status).toBe(403);
      const boundSearch = (await (await boundCall(`/search?q=${encodeURIComponent(suffix)}`)).json()) as { data: { bookId: string }[] };
      expect(new Set(boundSearch.data.map((contact) => contact.bookId))).toEqual(new Set([granted.shortId]));

      // Managing the book follows the grant too, but only a token with the `admin` scope reaches it.
      const managerWithoutAdminScope = await apiAs(manager, ["read", "write"]);
      expect(
        (await managerWithoutAdminScope(`/books/${granted.shortId}`, { method: "PATCH", body: { name: `Renamed ${suffix}` } })).status,
      ).toBe(403);
      expect((await managerWithoutAdminScope(`/books/${granted.shortId}/export.vcf`)).status).toBe(403);
      const managerWithAdminScope = await apiAs(manager, ["read", "write", "admin"]);
      const renamed = await managerWithAdminScope(`/books/${granted.shortId}`, { method: "PATCH", body: { name: `Renamed ${suffix}` } });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toMatchObject({ id: granted.shortId, name: `Renamed ${suffix}` });
      expect((await managerWithAdminScope(`/books/${granted.shortId}/export.vcf`)).status).toBe(200);

      // ACL management uses the same binding and scope limits as book data.
      await sql`UPDATE auth.access SET permission = 'admin' WHERE service_account_id = ${bound.id}::uuid`;
      expect((await boundCall(`/books/${granted.shortId}/access`)).status).toBe(403);
      const boundAdmin = await apiAs(bound, ["admin"]);
      expect((await boundAdmin(`/books/${granted.shortId}/access`)).status).toBe(200);
      expect((await boundAdmin(`/books/${other.shortId}/access`)).status).toBe(403);
      expect(
        (
          await boundAdmin(`/books/${other.shortId}/access`, {
            method: "POST",
            body: { principal: { type: "service_account", serviceAccountId: stranger.id }, permission: "read" },
          })
        ).status,
      ).toBe(403);
    } finally {
      await sql`DELETE FROM events.outbox WHERE app_id = 'contacts' AND ordering_key IN (${granted.id}, ${other.id})`;
      await sql`DELETE FROM contacts.books WHERE id IN (${granted.id}::uuid, ${other.id}::uuid)`;
      for (const id of accountIds) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.access WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
      }
    }
  });
});

const sharingSuite = suiteFor("database", "nats", "valkey");
sharingSuite("Contact book sharing by machine managers", () => {
  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind}: a named manager uses and changes grants with its credential, and revocation takes effect`, async () => {
      const suffix = crypto.randomUUID();
      const [owner] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
        VALUES (${`contacts-parity-${suffix}`}, 'local', 'user', 'Mara Lind') RETURNING id`;
      const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
        VALUES (${`Contact helper ${suffix}`}, ${kind}) RETURNING id`;
      const book = { id: crypto.randomUUID(), shortId: testShortId() };
      try {
        await sql`INSERT INTO contacts.books (id, short_id, name) VALUES (${book.id}::uuid, ${book.shortId}, 'Research contacts')`;
        const [ownerGrant] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission)
          VALUES (${owner!.id}::uuid, 'admin') RETURNING id`;
        await sql`INSERT INTO contacts.book_access (book_id, access_id) VALUES (${book.id}::uuid, ${ownerGrant!.id}::uuid)`;
        const cookie = `session_token=${await createTestSession(owner!.id)}`;
        const human = (path: string, method: string, body?: unknown) =>
          contactsApi.request(path, {
            method,
            headers: { cookie, "content-type": "application/json", "x-forwarded-for": uniqueCallerAddress() },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        const accessPath = `/books/${book.shortId}/access`;
        const machine = await apiAs(account!, ["admin"]);
        expect((await machine(`/books/${book.shortId}`)).status).toBe(403);
        const granted = await human(accessPath, "POST", {
          principal: { type: "service_account", serviceAccountId: account!.id },
          permission: "admin",
        });
        expect(granted.status).toBe(200);
        const entry = await granted.json();
        expect(entry).toMatchObject({ displayName: `Contact helper ${suffix}`, serviceAccountKind: kind });
        expect((await machine(`/books/${book.shortId}`)).status).toBe(200);
        expect(
          (await machine(`/books/${book.shortId}/contacts`, { method: "POST", body: { firstName: "Fictional", lastName: "Contact" } }))
            .status,
        ).toBe(200);
        const readOnly = await apiAs(account!, ["read"]);
        expect((await readOnly(accessPath)).status).toBe(403);
        expect((await readOnly(`${accessPath}/${ownerGrant!.id}`, { method: "PATCH", body: { permission: "read" } })).status).toBe(403);
        expect((await machine(accessPath)).status).toBe(200);
        const shared = await machine(accessPath, {
          method: "POST",
          body: { principal: { type: "authenticated" }, permission: "read" },
        });
        expect(shared.status).toBe(200);
        expect((await machine(`${accessPath}/${(await shared.json()).id}`, { method: "DELETE" })).status).toBe(200);
        // After the human manager steps down, the machine manager can restore them.
        expect((await human(`${accessPath}/${ownerGrant!.id}`, "PATCH", { permission: "read" })).status).toBe(200);
        expect((await machine(`${accessPath}/${entry.id}`, { method: "DELETE" })).status).toBe(409);
        expect((await machine(`${accessPath}/${ownerGrant!.id}`, { method: "PATCH", body: { permission: "admin" } })).status).toBe(200);
        expect((await human(`${accessPath}/${entry.id}`, "DELETE")).status).toBe(200);
        expect((await machine(`/books/${book.shortId}`)).status).toBe(403);
        expect((await machine(accessPath)).status).toBe(403);
        expect((await machine(`/books/${book.shortId}/contacts`, { method: "POST", body: { firstName: "Refused" } })).status).toBe(403);
      } finally {
        await sql`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM contacts.book_access WHERE book_id=${book.id}::uuid)`;
        await sql`DELETE FROM contacts.books WHERE id=${book.id}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id=${account!.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${owner!.id}::uuid`;
      }
    });
  }
});
