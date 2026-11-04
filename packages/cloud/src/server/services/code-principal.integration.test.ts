import { expect, test } from "bun:test";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { sql } from "../../runtime/clients";
import {
  AccessMutationBusyError,
  buildAccessPrincipalCondition,
  createAccess,
  getEffectivePermission,
  getEffectivePermissions,
  lockAccessMutationAuthority,
  updateAccess,
} from "./access";

const suite = databaseSuite();
suite("Code accounts in normal grants", () => {
  test("platform and database refuse Manage on create and update", async () => {
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
      VALUES (${`code-principal-${crypto.randomUUID()}`}, 'code') RETURNING id`;
    if (!account) throw new Error("Missing account");
    const principal = { type: "service_account" as const, serviceAccountId: account.id };
    try {
      expect(await createAccess({ principal, permission: "admin" })).toMatchObject({ ok: false, error: { status: 400 } });
      await expect(
        sql`INSERT INTO auth.access (service_account_id, permission)
        VALUES (${account.id}::uuid, 'admin')`.execute(),
      ).rejects.toMatchObject({ errno: "23514" });
      const created = await createAccess({ principal, permission: "read" });
      if (!created.ok) throw new Error(created.error.message);
      expect((await updateAccess({ id: created.data.id, permission: "write" })).ok).toBe(true);
      expect((await updateAccess({ id: created.data.id, permission: "read" })).ok).toBe(true);
      expect(await updateAccess({ id: created.data.id, permission: "admin" })).toMatchObject({ ok: false, error: { status: 400 } });
      await expect(sql`UPDATE auth.access SET permission = 'admin' WHERE id = ${created.data.id}::uuid`.execute()).rejects.toMatchObject({
        errno: "23514",
      });
      expect(await getEffectivePermission({ accessIds: [created.data.id], subject: principal })).toBe("read");
    } finally {
      await sql`DELETE FROM auth.service_accounts WHERE id = ${account.id}::uuid`;
    }
  });

  test("single, batched and joined resolvers ignore group, authenticated and public grants", async () => {
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
      VALUES (${`code-inherits-nothing-${crypto.randomUUID()}`}, 'code') RETURNING id`;
    const [group] = await sql<{ id: string }[]>`INSERT INTO auth.groups (cn, name, provider)
      VALUES (${`code-inherits-nothing-${crypto.randomUUID()}`}, 'Fixture', 'local') RETURNING id`;
    if (!account || !group) throw new Error("Missing fixture");
    const subject = { type: "service_account" as const, serviceAccountId: account.id };
    const ids: string[] = [];
    try {
      await sql`INSERT INTO auth.service_account_groups (service_account_id, group_id) VALUES (${account.id}::uuid, ${group.id}::uuid)`;
      for (const principal of [
        { type: "group" as const, groupId: group.id },
        { type: "authenticated" as const },
        { type: "public" as const },
      ]) {
        const grant = await createAccess({ principal, permission: "admin" });
        if (!grant.ok) throw new Error(grant.error.message);
        ids.push(grant.data.id);
        expect(await getEffectivePermission({ accessIds: [grant.data.id], subject })).toBe("none");
      }
      expect(await getEffectivePermission({ accessIds: ids, subject })).toBe("none");
      expect(await getEffectivePermissions({ accessIds: ids, subjects: [subject] })).toEqual(["none"]);
      const condition = buildAccessPrincipalCondition({
        subject,
        columns: {
          userId: sql`a.user_id`,
          groupId: sql`a.group_id`,
          serviceAccountId: sql`a.service_account_id`,
          authenticatedOnly: sql`a.authenticated_only`,
        },
      });
      expect(await sql`SELECT id FROM auth.access a WHERE ${condition}`).toHaveLength(0);
      const direct = await createAccess({ principal: subject, permission: "write" });
      if (!direct.ok) throw new Error(direct.error.message);
      ids.push(direct.data.id);
      expect(await getEffectivePermission({ accessIds: ids, subject })).toBe("write");
      expect(await getEffectivePermissions({ accessIds: ids, subjects: [subject] })).toEqual(["write"]);
      expect(await sql<{ id: string }[]>`SELECT id FROM auth.access a WHERE ${condition}`).toEqual([{ id: direct.data.id }]);
    } finally {
      for (const id of ids) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${account.id}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id = ${group.id}::uuid`;
    }
  });

  test("concurrent directory and person writes return a retryable conflict without waiting", async () => {
    const [person] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile)
      VALUES (${`code-manager-busy-${crypto.randomUUID()}`}, 'local', 'user') RETURNING id`;
    if (!person) throw new Error("Missing manager");
    try {
      for (const conflict of ["directory", "person"] as const) {
        await sql.begin(async (writer) => {
          if (conflict === "directory") await writer`LOCK TABLE auth.user_groups_v2 IN ROW EXCLUSIVE MODE`;
          else await writer`SELECT id FROM auth.users WHERE id = ${person.id}::uuid FOR UPDATE`;
          let failure: unknown;
          try {
            await sql.begin((tx) => lockAccessMutationAuthority({ subject: { type: "user", userId: person.id } }, tx));
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeInstanceOf(AccessMutationBusyError);
          if (!(failure instanceof AccessMutationBusyError)) throw new Error("Missing busy error");
          const response = failure.getResponse();
          expect(response.status).toBe(409);
          expect(await response.json()).toMatchObject({ code: "CONFLICT", retryable: true });
        });
      }
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${person.id}::uuid`;
    }
  });

  test("the common mutation lock refuses an expired manager and holds directory authority until commit", async () => {
    const [person] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`code-manager-lock-${crypto.randomUUID()}`}, 'local', 'user', 'Manager') RETURNING id`;
    if (!person) throw new Error("Missing person");
    const subject = { type: "user" as const, userId: person.id };
    try {
      await sql.begin(async (tx) => {
        expect(await lockAccessMutationAuthority({ subject }, tx)).toBe(true);
        await expect(
          sql.begin(async (other) => {
            await other`LOCK TABLE auth.user_groups_v2 IN ROW EXCLUSIVE MODE NOWAIT`;
          }),
        ).rejects.toMatchObject({ errno: "55P03" });
        await expect(
          sql.begin(async (other) => {
            await other`SELECT id FROM auth.users WHERE id = ${person.id}::uuid FOR UPDATE NOWAIT`;
          }),
        ).rejects.toMatchObject({ errno: "55P03" });
      });
      await sql`UPDATE auth.users SET account_expires = '2000-01-01T00:00:00Z' WHERE id = ${person.id}::uuid`;
      expect(await sql.begin((tx) => lockAccessMutationAuthority({ subject }, tx))).toBe(false);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${person.id}::uuid`;
    }
  });
});
