import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { accessScopeFor } from "./access-control";
import { listBases } from "./base-management";
import { seedActiveBaseStore } from "./base-store.test-fixture";

/** The base list costs the same few statements whether a person sees one base or many: no read per base. */
suiteFor("database", "valkey")("Pulse base list cost", () => {
  let memberId: string, accessId: string;
  const baseIds: string[] = [];
  beforeAll(async () => {
    const [person] = await sql<{ id: string }[]>`
      INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`list-member-${crypto.randomUUID()}`}, 'local', 'user', 'List member') RETURNING id`;
    memberId = person!.id;
    const [grant] = await sql<{ id: string }[]>`
      INSERT INTO auth.access(user_id, permission) VALUES (${memberId}::uuid, 'read') RETURNING id`;
    accessId = grant!.id;
  });
  afterAll(async () => {
    for (const id of baseIds) await sql`DELETE FROM pulse.bases WHERE id=${id}::uuid`;
    if (accessId) await sql`DELETE FROM auth.access WHERE id=${accessId}::uuid`;
    if (memberId) await sql`DELETE FROM auth.users WHERE id=${memberId}::uuid`;
  });
  const addBases = async (count: number) => {
    for (let index = 0; index < count; index++) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO pulse.bases(short_id, name, timezone) VALUES (${newShortId()}, ${`List ${baseIds.length}`}, 'Europe/Berlin')
        RETURNING id`;
      baseIds.push(row!.id);
      await sql`INSERT INTO pulse.base_access(base_id, access_id) VALUES (${row!.id}::uuid, ${accessId}::uuid)`;
    }
    // the last base has no store yet: it still lists, with the store it waits for
    await seedActiveBaseStore(...baseIds.slice(0, -1));
  };
  const scope = () => {
    const identity = adminFixtureIdentity(memberId, false);
    const result = accessScopeFor(identity.actor, identity.accessSubject);
    if (!result.ok) throw new Error("Missing access scope");
    return result.data;
  };
  const cost = async () => {
    // a running Cloud keeps its settings cached; the first read fills them, the second one counts
    await listBases(scope());
    const meter = await meterSql();
    try {
      let listed: Awaited<ReturnType<typeof listBases>> | undefined;
      const statements = await meter.during(async () => (listed = await listBases(scope())));
      if (!listed?.ok) throw new Error("The bases are not readable");
      return { statements: statements.length, bases: listed.data };
    } finally {
      await meter.close();
    }
  };

  test("listing one base or five costs the same statements, with each base's members and store", async () => {
    await addBases(1);
    const one = await cost();
    await addBases(4);
    const five = await cost();
    expect(one.bases).toHaveLength(1);
    expect(five.bases).toHaveLength(5);
    expect(five.statements).toBe(one.statements);
    // every base counts its one member; the stores read per base, the last one still waits for its store
    expect(five.bases.map((base) => base.memberCount)).toEqual([1, 1, 1, 1, 1]);
    const states = new Map(five.bases.map((base) => [base.id, base.store.state]));
    expect(baseIds.slice(0, -1).map((id) => states.get(id))).toEqual(["active", "active", "active", "active"]);
    expect(states.get(baseIds.at(-1)!)).toBe("failed");
  });
});
