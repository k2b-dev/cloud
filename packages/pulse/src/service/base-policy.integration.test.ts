import { expect } from "bun:test";
import { sql } from "bun";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { settingsFixture } from "../store/settings.test-fixture";
import { accessScopeFor, type ResourceScope } from "./access-control";
import { updateBaseLimits } from "./base-admin";
import { createBase } from "./base-management";
import { setPolicy } from "./base-policy";

const dbTest = testFor("database", "nats");
dbTest(
  "creation policy treats people and agents as grant owners and serializes the maximum",
  async () => {
    await migrate();
    const { createSync } = await import("@k2b/sync"),
      { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const connection = await connectTestNats({ ignoreClusterUpdates: true }),
      sync = createSync({ connection, namespace: testSyncNamespace("pulse-policy"), application: "pulse", defaults: { replicas: 1 } });
    const settings = settingsFixture(),
      ids: string[] = [];
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${`pulse-policy-${crypto.randomUUID()}`},'local','user','Policy fixture') RETURNING id`;
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name,kind) VALUES('Pulse policy fixture','agent') RETURNING id`;
    const agent: ResourceScope = {
      subject: { type: "service_account", serviceAccountId: account!.id },
      serviceAccount: { kind: "agent", appId: null, resourceType: null, resourceId: null },
      scopes: ["write"],
    };
    const identity = adminFixtureIdentity(user!.id);
    bindProcessSync(sync);
    try {
      for (const scope of [{ id: user!.id }, agent]) {
        const result = await createBase({ name: "Created by policy", user: scope, agent: "subject" in scope });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("CREATE_FAILED");
        ids.push(result.data.id);
        expect(result.data.store.state).toBe("provisioning");
        const [grant] =
          await sql`SELECT a.user_id,a.service_account_id,a.permission FROM pulse.base_access ba JOIN auth.access a ON a.id=ba.access_id WHERE ba.base_id=${result.data.id}::uuid`;
        expect(grant?.permission).toBe("admin");
        expect(grant?.user_id).toBe("id" in scope ? user!.id : null);
        expect(grant?.service_account_id).toBe("subject" in scope ? account!.id : null);
      }
      await setPolicy(identity, { baseCreation: "people" });
      expect(await createBase({ name: "Denied agent", user: agent, agent: true })).toMatchObject({
        ok: false,
        error: { status: 403, code: "PULSE_BASE_CREATION_NOT_ALLOWED" },
      });
      // Delegation changes the grant owner, not the request actor used by creation policy.
      if (identity.actor.kind !== "user") throw new Error("USER_FIXTURE_REQUIRED");
      const delegated = accessScopeFor(
        {
          kind: "service_account",
          serviceAccount: {
            id: account!.id,
            name: "Delegated fixture",
            kind: "user_delegated",
            status: "active",
            delegatedUserId: user!.id,
            appId: null,
            resourceType: null,
            resourceId: null,
            createdBy: user!.id,
            createdAt: "2026-10-17T12:00:00.000Z",
          },
          scopes: ["write"],
          delegatedUser: identity.actor.user,
        },
        { type: "user", userId: user!.id },
      );
      expect(delegated.ok).toBe(true);
      if (!delegated.ok) throw new Error("DELEGATED_SCOPE_FAILED");
      expect(await createBase({ name: "Denied delegated agent", user: delegated.data, agent: true, isCloudAdmin: true })).toMatchObject({
        ok: false,
        error: { status: 403, code: "PULSE_BASE_CREATION_NOT_ALLOWED" },
      });
      const person = await createBase({ name: "Allowed person", user: { id: user!.id }, agent: false });
      expect(person.ok).toBe(true);
      if (!person.ok) throw new Error("PERSON_CREATE_FAILED");
      ids.push(person.data.id);
      await setPolicy(identity, { baseCreation: "admins" });
      expect(await createBase({ name: "Denied person", user: { id: user!.id }, agent: false })).toMatchObject({
        ok: false,
        error: { status: 403 },
      });
      await setPolicy(identity, { baseCreation: "everyone", maxBases: 1 });
      const limited = await createBase({ name: "Over maximum", user: { id: user!.id }, agent: false });
      expect(limited).toMatchObject({ ok: false, error: { code: "PULSE_BASE_LIMIT_REACHED", status: 409 } });
      if (!limited.ok)
        expect(limited.error.message).toContain("A Cloud admin can raise the maximum under Administration -> Pulse -> Bases");
      await expect(updateBaseLimits(adminFixtureIdentity(user!.id, false), "bad", {})).rejects.toMatchObject({
        code: "ACCESS_DENIED",
        status: 403,
      });
    } finally {
      for (const id of ids) {
        await sql`DELETE FROM auth.access WHERE id IN(SELECT access_id FROM pulse.base_access WHERE base_id=${id}::uuid)`;
        await sql`DELETE FROM pulse.bases WHERE id=${id}::uuid`;
      }
      await sql`DELETE FROM auth.service_accounts WHERE id=${account!.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
      settings.restore();
      await sync.drain({ timeoutMs: 5000 });
      unbindProcessSync();
      await connection.drain();
    }
  },
  60_000,
);
