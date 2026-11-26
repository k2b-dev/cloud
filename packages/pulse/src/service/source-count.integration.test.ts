import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { accessScopeFor } from "./access-control";
import { countSources, sourceFigures } from "./source-management";

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
    // a healthy source, two failing ones (the printer failed last), a paused one that failed, and a deleted failing one
    for (const [name, deleted, enabled, failedAt] of [
      ["Server", false, true, null],
      ["Shop", false, true, "2026-11-25T08:00:00Z"],
      ["Printer", false, true, "2026-11-25T09:40:00Z"],
      ["Paused", false, false, "2026-11-24T09:00:00Z"],
      ["Removed", true, true, "2026-11-25T09:50:00Z"],
    ] as const)
      await sql`INSERT INTO pulse.sources(short_id, base_id, kind, name, deleted, enabled, last_error, last_error_at)
        VALUES (${newShortId()}, ${baseId}::uuid, 'metrics', ${name}, ${deleted}, ${enabled},
          ${failedAt ? "Metrics scrape timed out after 15 seconds" : null}, ${failedAt}::timestamptz)`;
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
    expect(await countSources(baseId, scope(memberId))).toMatchObject({ ok: true, data: 4 });
  });

  test("someone without access to the base gets an error, never a number", async () => {
    const result = await countSources(baseId, scope(strangerId));
    expect(result.ok).toBe(false);
  });

  test("the figures cover every source but the deleted, name the newest failures first and have no today without a store", async () => {
    const figures = await sourceFigures(baseId, scope(memberId), new Date("2026-11-25T10:00:00Z"));
    if (!figures.ok) throw new Error("The figures are not readable");
    expect(figures.data).toMatchObject({ total: 4, active: 3, failingCount: 2, series: 0, today: null });
    expect(figures.data.failing.map((source) => source.name)).toEqual(["Printer", "Shop"]);
    expect((await sourceFigures(baseId, scope(strangerId))).ok).toBe(false);
  });
});
