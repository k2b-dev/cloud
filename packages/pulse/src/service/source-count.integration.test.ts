import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { accessScopeFor } from "./access-control";
import { countSources } from "./source-management";

const suite = databaseSuite();
suite("Pulse source count", () => {
  let memberId: string, strangerId: string, baseId: string, accessId: string;
  beforeAll(async () => {
    const people = await sql<{ id: string }[]>`
      INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`count-member-${crypto.randomUUID()}`}, 'local', 'user', 'Count member'),
             (${`count-stranger-${crypto.randomUUID()}`}, 'local', 'user', 'Count stranger')
      RETURNING id`;
    memberId = people[0]!.id;
    strangerId = people[1]!.id;
    const [base] = await sql<
      { id: string }[]
    >`INSERT INTO pulse.bases(short_id, name) VALUES (${newShortId()}, 'Count fixture') RETURNING id`;
    baseId = base!.id;
    const [grant] = await sql<{ id: string }[]>`
      INSERT INTO auth.access(user_id, permission) VALUES (${memberId}::uuid, 'read') RETURNING id`;
    accessId = grant!.id;
    await sql`INSERT INTO pulse.base_access(base_id, access_id) VALUES (${baseId}::uuid, ${accessId}::uuid)`;
    for (const [name, deleted] of [
      ["Server", false],
      ["Shop", false],
      ["Removed", true],
    ] as const)
      await sql`INSERT INTO pulse.sources(short_id, base_id, kind, name, deleted)
        VALUES (${newShortId()}, ${baseId}::uuid, 'metrics', ${name}, ${deleted})`;
  });
  afterAll(async () => {
    if (baseId) await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
    if (accessId) await sql`DELETE FROM auth.access WHERE id=${accessId}::uuid`;
    for (const id of [memberId, strangerId]) if (id) await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
  });
  const scope = (id: string) => {
    const identity = adminFixtureIdentity(id, false);
    const result = accessScopeFor(identity.actor, identity.accessSubject);
    if (!result.ok) throw new Error("Missing access scope");
    return result.data;
  };

  test("a reader counts the base's sources without the deleted one", async () => {
    expect(await countSources(baseId, scope(memberId))).toMatchObject({ ok: true, data: 2 });
  });

  test("someone without access to the base gets an error, never a number", async () => {
    const result = await countSources(baseId, scope(strangerId));
    expect(result.ok).toBe(false);
  });
});
