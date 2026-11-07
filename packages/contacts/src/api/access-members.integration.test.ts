import { expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import contactsApi from ".";

const suite = databaseSuite();
setDefaultTimeout(30_000);

type Principal = { userId: string } | { serviceAccountId: string } | "authenticated" | "public";

const grant = async (bookId: string, principal: Principal, permission: "read" | "write" | "admin") => {
  const [access] =
    principal === "public"
      ? await sql<{ id: string }[]>`INSERT INTO auth.access (permission) VALUES (${permission}) RETURNING id`
      : principal === "authenticated"
        ? await sql<{ id: string }[]>`INSERT INTO auth.access (authenticated_only, permission) VALUES (true, ${permission}) RETURNING id`
        : "userId" in principal
          ? await sql<
              { id: string }[]
            >`INSERT INTO auth.access (user_id, permission) VALUES (${principal.userId}::uuid, ${permission}) RETURNING id`
          : await sql<{ id: string }[]>`
              INSERT INTO auth.access (service_account_id, permission) VALUES (${principal.serviceAccountId}::uuid, ${permission}) RETURNING id`;
  await sql`INSERT INTO contacts.book_access (book_id, access_id) VALUES (${bookId}::uuid, ${access!.id}::uuid)`;
  return access!.id;
};

/** Calls the real Contacts API with a credential of the given service account. */
const apiAs = async (serviceAccountId: string, scopes: string[]) => {
  const created = await serviceAccountCredentials.createApiToken({ serviceAccountId, name: `test ${scopes.join(" ")}`, scopes });
  if (!created.ok) throw new Error(created.error.message);
  const authorization = `Bearer ${created.data.token}`;
  return (path: string) => contactsApi.request(path, { headers: { authorization } });
};

suite("Contacts access members", () => {
  test("everyone with access of their own sees who has access, read-only; public access alone and outsiders do not", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const books = [
      { id: crypto.randomUUID(), short_id: testShortId() },
      { id: crypto.randomUUID(), short_id: testShortId() },
      { id: crypto.randomUUID(), short_id: testShortId() },
    ];
    for (const [index, book] of books.entries())
      await sql`INSERT INTO contacts.books (id, short_id, name) VALUES (${book.id}::uuid, ${book.short_id}, ${`Members ${index} ${suffix}`})`;
    const [shared, signedIn, closed] = books as [(typeof books)[number], (typeof books)[number], (typeof books)[number]];
    const userIds: string[] = [];
    const accountIds: string[] = [];
    const accessIds: string[] = [];
    try {
      const users = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name)
        VALUES
          (${`book-members-owner-${suffix}`}, 'local', 'user', 'Jana Berger'),
          (${`book-members-reader-${suffix}`}, 'local', 'user', 'Paul Wagner'),
          (${`book-members-link-${suffix}`}, 'local', 'user', 'Link Reader')
        RETURNING id`;
      const [owner, reader, linkReader] = users.map((row) => row.id) as [string, string, string];
      userIds.push(owner, reader, linkReader);
      // A user-delegated key acts as its person, so these calls carry exactly the person's book permission.
      const delegated = await sql<{ id: string }[]>`
        INSERT INTO auth.service_accounts (name, kind, delegated_user_id)
        VALUES
          (${`Owner key ${suffix}`}, 'user_delegated', ${owner}::uuid),
          (${`Reader key ${suffix}`}, 'user_delegated', ${reader}::uuid),
          (${`Link key ${suffix}`}, 'user_delegated', ${linkReader}::uuid)
        RETURNING id`;
      const [agent] = await sql<
        { id: string }[]
      >`INSERT INTO auth.service_accounts (name, kind) VALUES (${`Agent ${suffix}`}, 'agent') RETURNING id`;
      const [bound] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
        VALUES (${`Bound ${suffix}`}, 'resource_bound', 'contacts', 'contact_book', ${closed.id}) RETURNING id`;
      accountIds.push(...delegated.map((row) => row.id), agent!.id, bound!.id);

      accessIds.push(
        await grant(shared.id, { userId: owner }, "admin"),
        await grant(shared.id, { userId: reader }, "read"),
        await grant(shared.id, { serviceAccountId: agent!.id }, "write"),
        await grant(shared.id, { serviceAccountId: bound!.id }, "read"),
        await grant(shared.id, "public", "read"),
        await grant(signedIn.id, "authenticated", "read"),
        await grant(closed.id, { userId: owner }, "admin"),
      );

      const scopes = ["openid", "read"];
      const asOwner = await apiAs(delegated[0]!.id, scopes);
      const asReader = await apiAs(delegated[1]!.id, scopes);
      const asLinkReader = await apiAs(delegated[2]!.id, scopes);
      const asAgent = await apiAs(agent!.id, scopes);
      const asBound = await apiAs(bound!.id, scopes);

      // A reader with a grant of their own sees everyone, the public grant included, by name and role only.
      const listed = await asReader(`/books/${shared.short_id}/access/members`);
      expect(listed.status).toBe(200);
      const members = (await listed.json()) as Record<string, unknown>[];
      expect(members).toHaveLength(5);
      expect(members).toContainEqual(
        expect.objectContaining({ principal: { type: "user", userId: owner }, permission: "admin", displayName: "Jana Berger" }),
      );
      expect(members).toContainEqual(expect.objectContaining({ principal: { type: "public" }, permission: "read" }));
      for (const member of members) {
        expect(member).not.toHaveProperty("id");
        expect(member).not.toHaveProperty("createdAt");
        expect(member).not.toHaveProperty("scope");
      }
      expect((await asOwner(`/books/${shared.short_id}/access/members`)).status).toBe(200);
      expect((await asAgent(`/books/${shared.short_id}/access/members`)).status).toBe(200);
      // The managers' list with grant IDs stays theirs.
      expect((await asReader(`/books/${shared.short_id}/access`)).status).toBe(403);
      // A key bound to another book holds nothing here, even with a grant.
      expect((await asBound(`/books/${shared.short_id}/access/members`)).status).toBe(403);

      // Reading only through public access never shows who else has access.
      expect((await asLinkReader(`/books/${shared.short_id}/contacts`)).status).toBe(200);
      expect((await asLinkReader(`/books/${shared.short_id}/access/members`)).status).toBe(403);
      // "Everyone signed in" is access of one's own.
      expect((await asLinkReader(`/books/${signedIn.short_id}/access/members`)).status).toBe(200);
      // Without access, and for a book that does not exist, nothing is listed.
      expect((await asReader(`/books/${closed.short_id}/access/members`)).status).toBe(403);
      expect((await asReader(`/books/${testShortId()}/access/members`)).status).toBe(404);
    } finally {
      for (const book of books) await sql`DELETE FROM contacts.books WHERE id = ${book.id}::uuid`;
      for (const id of accessIds) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
      for (const id of accountIds) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.access WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
      }
      for (const id of userIds) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    }
  });
});
