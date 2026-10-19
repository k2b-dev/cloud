import { expect } from "bun:test";
import { sql } from "bun";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { settingsFixture } from "../store/settings.test-fixture";
import type { ResourceScope } from "./access-control";
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
        const result = await createBase({ name: "Created by policy", user: scope });
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
      expect(await createBase({ name: "Denied agent", user: agent })).toMatchObject({
        ok: false,
        error: { status: 403, code: "PULSE_BASE_CREATION_NOT_ALLOWED" },
      });
      await setPolicy(identity, { baseCreation: "admins" });
      expect(await createBase({ name: "Denied person", user: { id: user!.id } })).toMatchObject({ ok: false, error: { status: 403 } });
      await setPolicy(identity, { baseCreation: "everyone", maxBases: 1 });
      const limited = await createBase({ name: "Over maximum", user: { id: user!.id } });
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
