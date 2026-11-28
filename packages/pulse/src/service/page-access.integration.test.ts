import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { accessScopeFor, requireBaseAccess, withPageAccess } from "./access-control";

/**
 * A page load reads a person's grant on a base once, however many services check it; nothing beyond that load
 * keeps the answer: the next request, work the load left running, an API call and a transaction read it fresh.
 */
suiteFor("database", "valkey")("Pulse grant read per page load", () => {
  let memberId: string, baseId: string, accessId: string;
  beforeAll(async () => {
    const [person] = await sql<{ id: string }[]>`
      INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`grant-reader-${crypto.randomUUID()}`}, 'local', 'user', 'Grant reader') RETURNING id`;
    memberId = person!.id;
    const [base] = await sql<{ id: string }[]>`
      INSERT INTO pulse.bases(short_id, name, timezone) VALUES (${newShortId()}, 'Grants', 'Europe/Berlin') RETURNING id`;
    baseId = base!.id;
  });
  afterAll(async () => {
    if (baseId) await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
    if (accessId) await sql`DELETE FROM auth.access WHERE id=${accessId}::uuid`;
    if (memberId) await sql`DELETE FROM auth.users WHERE id=${memberId}::uuid`;
  });
  const scope = () => {
    const identity = adminFixtureIdentity(memberId, false);
    const result = accessScopeFor(identity.actor, identity.accessSubject);
    if (!result.ok) throw new Error("Missing access scope");
    return result.data;
  };
  const grant = async () => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id, permission) VALUES (${memberId}::uuid, 'read') RETURNING id`;
    accessId = row!.id;
    await sql`INSERT INTO pulse.base_access(base_id, access_id) VALUES (${baseId}::uuid, ${accessId}::uuid)`;
  };
  const revoke = async () => {
    await sql`DELETE FROM auth.access WHERE id=${accessId}::uuid`;
  };
  const grantReads = (statements: string[]) => statements.filter((text) => text.includes("MAX(a.permission)"));

  test("one page load reads the grant once; the next load after a revoke reads it fresh and is refused", async () => {
    await grant();
    const meter = await meterSql();
    try {
      const results: boolean[] = [];
      const reads = await meter.during(() =>
        withPageAccess(async () => {
          for (let check = 0; check < 3; check++) results.push((await requireBaseAccess(baseId, scope(), "read")).ok);
        }),
      );
      expect(results).toEqual([true, true, true]);
      expect(grantReads(reads)).toHaveLength(1);
      await revoke();
      expect((await withPageAccess(() => requireBaseAccess(baseId, scope(), "read"))).ok).toBe(false);
    } finally {
      await meter.close();
    }
  });

  test("work a page load leaves running reads fresh once the load is answered", async () => {
    await grant();
    let later: Promise<boolean> | undefined;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withPageAccess(async () => {
      expect((await requireBaseAccess(baseId, scope(), "read")).ok).toBe(true);
      // started inside the load, it checks again only after the page was answered and the grant was revoked
      later = gate.then(async () => (await requireBaseAccess(baseId, scope(), "read")).ok);
    });
    await revoke();
    release();
    expect(await later).toBe(false);
  });

  test("an API call outside a page load and a transaction inside one read the grant every time", async () => {
    await grant();
    const meter = await meterSql();
    try {
      const outside = await meter.during(async () => {
        await requireBaseAccess(baseId, scope(), "read");
        await requireBaseAccess(baseId, scope(), "read");
      });
      expect(grantReads(outside)).toHaveLength(2);
      const inTransaction = await meter.during(() =>
        withPageAccess(() =>
          sql.begin(async (tx) => {
            await requireBaseAccess(baseId, scope(), "read", tx);
            await requireBaseAccess(baseId, scope(), "read", tx);
          }),
        ),
      );
      expect(grantReads(inTransaction)).toHaveLength(2);
    } finally {
      await meter.close();
      await revoke();
    }
  });
});
