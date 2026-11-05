import { expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { newShortId } from "../lib/short-id";
import { getSpaceMemberPermission } from "../service/access";
import spacesApi from ".";

const suite = databaseSuite();
setDefaultTimeout(30_000);

type Principal = { userId: string } | { serviceAccountId: string } | "authenticated" | "public";

const grant = async (spaceId: string, principal: Principal, permission: "read" | "write" | "admin") => {
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
  await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${access!.id}::uuid)`;
  return access!.id;
};

/** Calls the real Spaces API with a credential of the given service account. */
const apiAs = async (serviceAccountId: string, scopes: string[]) => {
  const created = await serviceAccountCredentials.createApiToken({ serviceAccountId, name: `test ${scopes.join(" ")}`, scopes });
  if (!created.ok) throw new Error(created.error.message);
  const authorization = `Bearer ${created.data.token}`;
  return (path: string) => spacesApi.request(path, { headers: { authorization } });
};

suite("Spaces access members", () => {
  test("everyone with access of their own sees who has access, read-only; public access alone and outsiders do not", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const spaces = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name)
      VALUES (${newShortId()}, ${`Shared ${suffix}`}), (${newShortId()}, ${`Signed in ${suffix}`}), (${newShortId()}, ${`Closed ${suffix}`})
      RETURNING id, short_id`;
    const [shared, signedIn, closed] = spaces as [(typeof spaces)[number], (typeof spaces)[number], (typeof spaces)[number]];
    const userIds: string[] = [];
    const accountIds: string[] = [];
    const accessIds: string[] = [];
    try {
      const users = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name)
        VALUES
          (${`space-members-owner-${suffix}`}, 'local', 'user', 'Jana Berger'),
          (${`space-members-reader-${suffix}`}, 'local', 'user', 'Paul Wagner'),
          (${`space-members-link-${suffix}`}, 'local', 'user', 'Link Reader')
        RETURNING id`;
      const [owner, reader, linkReader] = users.map((row) => row.id) as [string, string, string];
      userIds.push(owner, reader, linkReader);
      // A user-delegated key acts as its person, so these calls carry exactly the person's space permission.
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
        VALUES (${`Bound ${suffix}`}, 'resource_bound', 'spaces', 'space', ${closed.id}) RETURNING id`;
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
      const listed = await asReader(`/${shared.short_id}/access/members`);
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
      expect((await asOwner(`/${shared.short_id}/access/members`)).status).toBe(200);
      expect((await asAgent(`/${shared.short_id}/access/members`)).status).toBe(200);
      // The managers' list with grant IDs stays theirs.
      expect((await asReader(`/${shared.short_id}/access`)).status).toBe(403);
      // A key bound to another space holds nothing here, even with a grant.
      expect((await asBound(`/${shared.short_id}/access/members`)).status).toBe(403);

      // Reading only through public access never shows who else has access.
      expect((await asLinkReader(`/${shared.short_id}`)).status).toBe(200);
      expect((await asLinkReader(`/${shared.short_id}/access/members`)).status).toBe(403);
      // "Everyone signed in" is access of one's own.
      expect((await asLinkReader(`/${signedIn.short_id}/access/members`)).status).toBe(200);
      // Without access, and for a space that does not exist, nothing is listed.
      expect((await asReader(`/${closed.short_id}/access/members`)).status).toBe(403);
      expect((await asReader(`/${newShortId()}/access/members`)).status).toBe(404);

      // The page decides with the same rule, so the section is absent rather than empty for public-only readers.
      expect(await getSpaceMemberPermission({ spaceId: shared.id, subject: { type: "user", userId: reader } })).toBe("read");
      expect(await getSpaceMemberPermission({ spaceId: shared.id, subject: { type: "user", userId: linkReader } })).toBe("none");
    } finally {
      for (const space of spaces) await sql`DELETE FROM spaces.spaces WHERE id = ${space.id}::uuid`;
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
