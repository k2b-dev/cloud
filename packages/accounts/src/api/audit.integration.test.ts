import { afterAll, expect, test } from "bun:test";
import { audit } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import auditRoutes from "./audit";

const suite = suiteFor("database", "nats", "valkey");
const created: string[] = [];

const person = async (name: string, admin = false) => {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, admin)
    VALUES (${`accounts-audit-${crypto.randomUUID()}`}, 'local', 'user', ${name}, ${admin}) RETURNING id`;
  created.push(user!.id);
  return user!.id;
};

type Listed = { events: Array<{ action: string; actor: { userId: string | null; uid: string | null; displayName?: string } }> };

suite("Accounts audit actors", () => {
  afterAll(async () => {
    for (const id of created) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("names actors recorded with only a user ID, and leaves deleted actors unnamed", async () => {
    const adminId = await person("Admin Example", true);
    const actorId = await person("Mara Lind");
    const goneId = crypto.randomUUID();
    const action = `test.audit.actor.${crypto.randomUUID().slice(0, 8)}`;
    await audit.record({ action, outcome: "allowed", actor: { userId: actorId } });
    await audit.record({ action, outcome: "allowed", actor: { userId: goneId } });
    await audit.record({ action, outcome: "allowed", actor: { userId: adminId, uid: "recorded-login" } });

    const response = await auditRoutes.request(`/?action=${action}`, {
      headers: { cookie: `session_token=${await createTestSession(adminId)}`, "x-forwarded-for": uniqueCallerAddress() },
    });
    expect(response.status).toBe(200);
    const { events } = (await response.json()) as Listed;
    const byUser = new Map(events.map((event) => [event.actor.userId, event.actor]));
    expect(byUser.get(actorId)).toEqual(expect.objectContaining({ uid: null, displayName: "Mara Lind" }));
    expect(byUser.get(goneId)).not.toHaveProperty("displayName");
    // A recorded login stays authoritative; no lookup replaces it.
    expect(byUser.get(adminId)).toEqual(expect.objectContaining({ uid: "recorded-login" }));
    expect(byUser.get(adminId)).not.toHaveProperty("displayName");
  });
});
