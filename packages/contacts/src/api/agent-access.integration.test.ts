import { expect, setDefaultTimeout, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { contactsService } from "../service";
import contactsApi from ".";

const suite = databaseSuite();
setDefaultTimeout(30_000);

const shortId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 6);

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
    const granted = { id: crypto.randomUUID(), shortId: shortId(), name: `Agent granted ${suffix}` };
    const other = { id: crypto.randomUUID(), shortId: shortId(), name: `Agent other ${suffix}` };
    await sql`INSERT INTO contacts.books (id, short_id, name) VALUES
      (${granted.id}::uuid, ${granted.shortId}, ${granted.name}), (${other.id}::uuid, ${other.shortId}, ${other.name})`;
    const accountIds: string[] = [];
    try {
      const email = `ada.${suffix}@example.test`;
      const created = await contactsService.contact.create({
        bookId: granted.id,
        data: { firstName: "Ada", lastName: `Example ${suffix}`, emails: [{ email }] },
      });
      if (!created.ok) throw new Error(created.error.message);
      const hidden = await contactsService.contact.create({
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
