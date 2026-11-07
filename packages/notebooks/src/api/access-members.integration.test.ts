import { expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import "../../../../scripts/fixtures/authorization-preload";
import notebooksApi from ".";

const suite = databaseSuite();
setDefaultTimeout(30_000);

type Principal = { userId: string } | { serviceAccountId: string } | "authenticated" | "public";

const grant = async (notebookId: string, principal: Principal, permission: "read" | "write" | "admin") => {
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
  await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebookId}::uuid, ${access!.id}::uuid)`;
  return access!.id;
};

/** Calls the real Notebooks API with a credential of the given service account. */
const apiAs = async (serviceAccountId: string, scopes: string[]) => {
  const created = await serviceAccountCredentials.createApiToken({ serviceAccountId, name: `test ${scopes.join(" ")}`, scopes });
  if (!created.ok) throw new Error(created.error.message);
  const authorization = `Bearer ${created.data.token}`;
  return (path: string) => notebooksApi.request(path, { headers: { authorization } });
};

suite("Notebooks access members", () => {
  test("everyone with access of their own sees who has access, read-only; public access alone and outsiders do not", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const shared = { id: crypto.randomUUID(), shortId: testShortId() };
    const signedIn = { id: crypto.randomUUID(), shortId: testShortId() };
    const closed = { id: crypto.randomUUID(), shortId: testShortId() };
    for (const notebook of [shared, signedIn, closed])
      await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebook.id}::uuid, ${notebook.shortId}, ${`Members ${suffix}`})`;
    const userIds: string[] = [];
    const accountIds: string[] = [];
    const accessIds: string[] = [];
    try {
      const users = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name)
        VALUES
          (${`members-owner-${suffix}`}, 'local', 'user', 'Jana Berger'),
          (${`members-reader-${suffix}`}, 'local', 'user', 'Paul Wagner'),
          (${`members-link-${suffix}`}, 'local', 'user', 'Link Reader')
        RETURNING id`;
      const [owner, reader, linkReader] = users.map((row) => row.id) as [string, string, string];
      userIds.push(owner, reader, linkReader);
      // A user-delegated key acts as its person, so these calls carry exactly the person's notebook permission.
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
      accountIds.push(...delegated.map((row) => row.id), agent!.id);

      accessIds.push(
        await grant(shared.id, { userId: owner }, "admin"),
        await grant(shared.id, { userId: reader }, "read"),
        await grant(shared.id, { serviceAccountId: agent!.id }, "write"),
        await grant(shared.id, "public", "read"),
        await grant(signedIn.id, "authenticated", "read"),
        await grant(closed.id, { userId: owner }, "admin"),
      );

      const scopes = ["openid", "read"];
      const asOwner = await apiAs(delegated[0]!.id, scopes);
      const asReader = await apiAs(delegated[1]!.id, scopes);
      const asLinkReader = await apiAs(delegated[2]!.id, scopes);
      const asAgent = await apiAs(agent!.id, scopes);

      // A reader with a grant of their own sees everyone, the public grant included, by name and role only.
      const listed = await asReader(`/${shared.shortId}/access/members`);
      expect(listed.status).toBe(200);
      const members = (await listed.json()) as Record<string, unknown>[];
      expect(members).toHaveLength(4);
      expect(members).toContainEqual(
        expect.objectContaining({ principal: { type: "user", userId: owner }, permission: "admin", displayName: "Jana Berger" }),
      );
      expect(members).toContainEqual(expect.objectContaining({ principal: { type: "public" }, permission: "read" }));
      for (const member of members) {
        expect(member).not.toHaveProperty("id");
        expect(member).not.toHaveProperty("createdAt");
        expect(member).not.toHaveProperty("scope");
      }
      expect((await asOwner(`/${shared.shortId}/access/members`)).status).toBe(200);
      expect((await asAgent(`/${shared.shortId}/access/members`)).status).toBe(200);
      // The managers' list with grant IDs stays theirs.
      expect((await asReader(`/${shared.shortId}/access`)).status).toBe(403);

      // Reading only through the public link never shows who else has access.
      expect((await asLinkReader(`/${shared.shortId}`)).status).toBe(200);
      expect((await asLinkReader(`/${shared.shortId}/access/members`)).status).toBe(403);
      // "Everyone signed in" is access of one's own.
      expect((await asLinkReader(`/${signedIn.shortId}/access/members`)).status).toBe(200);
      // Without access, and for a notebook that does not exist, nothing is listed.
      expect((await asReader(`/${closed.shortId}/access/members`)).status).toBe(403);
      expect((await asReader(`/${testShortId()}/access/members`)).status).toBe(404);
    } finally {
      for (const notebook of [shared, signedIn, closed]) await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebook.id}::uuid`;
      for (const id of accessIds) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
      for (const id of accountIds) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.access WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
      }
      for (const id of userIds) {
        await sql`DELETE FROM auth.access WHERE user_id = ${id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
      }
    }
  });
});
