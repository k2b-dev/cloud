import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { ServiceAccount } from "@k2b/cloud/services";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { type AccessScope, accessScopeFor } from "./access-control";
import { getBase, listBases } from "./base-management";

const suite = databaseSuite();
suite("Pulse base members", () => {
  const ids = { admin: "", reader: "", agent: "", base: "" };
  const grants: string[] = [];
  beforeAll(async () => {
    const people = await sql<{ id: string }[]>`
      INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`members-admin-${crypto.randomUUID()}`}, 'local', 'user', 'Members admin'),
             (${`members-reader-${crypto.randomUUID()}`}, 'local', 'user', 'Members reader')
      RETURNING id`;
    ids.admin = people[0]!.id;
    ids.reader = people[1]!.id;
    const [agent] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name, kind) VALUES ('Members agent', 'agent') RETURNING id`;
    ids.agent = agent!.id;
    const [base] = await sql<
      { id: string }[]
    >`INSERT INTO pulse.bases(short_id, name) VALUES (${newShortId()}, 'Members fixture') RETURNING id`;
    ids.base = base!.id;
    for (const [user, account, permission] of [
      [ids.admin, null, "admin"],
      [ids.reader, null, "read"],
      [null, ids.agent, "admin"],
    ] as const) {
      const [grant] = await sql<{ id: string }[]>`
        INSERT INTO auth.access(user_id, service_account_id, permission)
        VALUES (${user}::uuid, ${account}::uuid, ${permission}) RETURNING id`;
      grants.push(grant!.id);
      await sql`INSERT INTO pulse.base_access(base_id, access_id) VALUES (${ids.base}::uuid, ${grant!.id}::uuid)`;
    }
  });
  afterAll(async () => {
    if (ids.base) await sql`DELETE FROM pulse.bases WHERE id=${ids.base}::uuid`;
    for (const id of grants) await sql`DELETE FROM auth.access WHERE id=${id}::uuid`;
    if (ids.agent) await sql`DELETE FROM auth.service_accounts WHERE id=${ids.agent}::uuid`;
    for (const id of [ids.admin, ids.reader]) if (id) await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
  });
  const person = (id: string): AccessScope => {
    const identity = adminFixtureIdentity(id, false);
    const scope = accessScopeFor(identity.actor, identity.accessSubject);
    if (!scope.ok) throw new Error("Missing access scope");
    return scope.data;
  };
  /** The agent's token with read scope only, although its grant on the base is admin. */
  const readToken = (): AccessScope => {
    const serviceAccount: ServiceAccount = {
      id: ids.agent,
      name: "Members agent",
      kind: "agent",
      status: "active",
      delegatedUserId: null,
      appId: null,
      resourceId: null,
      resourceType: null,
      createdBy: null,
      createdAt: "2026-11-26T08:00:00.000Z",
    };
    const scope = accessScopeFor(
      { kind: "service_account", serviceAccount, delegatedUser: null, scopes: ["read"] },
      { type: "service_account", serviceAccountId: ids.agent },
    );
    if (!scope.ok) throw new Error("Missing token scope");
    return scope.data;
  };

  test("an admin of the base reads its first members by name, admins first", async () => {
    const base = await getBase(ids.base, person(ids.admin));
    if (!base.ok) throw new Error("The admin cannot read the base");
    expect(base.data.memberCount).toBe(3);
    expect(base.data.members?.map((member) => member.displayName)).toEqual(["Members admin", "Members agent", "Members reader"]);
    const listed = await listBases(person(ids.admin));
    expect(listed.ok && listed.data.find((entry) => entry.id === ids.base)?.members).toHaveLength(3);
  });

  test("a reader and a read token see how many members there are, not who they are", async () => {
    for (const scope of [person(ids.reader), readToken()]) {
      const base = await getBase(ids.base, scope);
      if (!base.ok) throw new Error("The base is not readable");
      expect(base.data.memberCount).toBe(3);
      expect(base.data.members).toBeUndefined();
      const listed = await listBases(scope);
      expect(listed.ok && listed.data.find((entry) => entry.id === ids.base)?.members).toBeUndefined();
    }
  });
});
