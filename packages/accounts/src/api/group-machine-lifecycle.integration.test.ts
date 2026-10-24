import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { prepareIdentitySigner } from "@k2b/cloud/services/identity/key-ring";
import { getIdentityRuntimeConfig } from "@k2b/cloud/services/identity/runtime-config";
import { sql } from "bun";
import { SignJWT } from "jose";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import groups from "./groups";

const blockedBy = async (blocker: number, waiter?: number) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [row] = await db<{ pid: number }[]>`SELECT pid FROM pg_stat_activity
      WHERE ${blocker}=ANY(pg_blocking_pids(pid)) AND (${waiter ?? null}::int IS NULL OR pid=${waiter ?? null})`;
    if (row) return row.pid;
    await Bun.sleep(10);
  }
  throw new Error("Expected the fixture transaction to wait on its authorization lock");
};

const fixture = (kind: "standalone" | "agent") =>
  sql.begin(async (db) => {
    const suffix = crypto.randomUUID();
    const [machine] = await db<{ id: string }[]>`INSERT INTO auth.service_accounts(name,kind)
    VALUES(${`Lifecycle ${suffix}`},${kind}) RETURNING id`;
    const [group] = await db<{ id: string }[]>`INSERT INTO auth.groups(cn,name,provider)
    VALUES(${`local:lifecycle-${suffix}`},${`lifecycle-${suffix}`},'local') RETURNING id`;
    const [member] = await db<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile)
    VALUES(${`lifecycle-member-${suffix}`},'local','user') RETURNING id`;
    const clientId = `group-lifecycle-${suffix}`;
    await db`INSERT INTO oauth.clients(name,client_id,redirect_uris)
    VALUES(${clientId},${clientId},ARRAY[]::text[])`;
    await db`INSERT INTO auth.group_manager_service_accounts(group_id,service_account_id)
    VALUES(${group!.id}::uuid,${machine!.id}::uuid)`;
    return {
      machineId: machine!.id,
      clientId,
      groupId: group!.id,
      memberId: member!.id,
      call: (token: string, method = "POST") =>
        groups.request(`/${group!.id}/members`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ type: "user", id: member!.id }),
        }),
      members: () => sql`SELECT 1 FROM auth.user_groups_v2 WHERE group_id=${group!.id}::uuid AND user_id=${member!.id}::uuid`,
      clean: async () => {
        await sql`DELETE FROM oauth.clients WHERE client_id=${clientId}`;
        await sql`DELETE FROM auth.service_accounts WHERE id=${machine!.id}::uuid`;
        await sql`DELETE FROM auth.groups WHERE id=${group!.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${member!.id}::uuid`;
      },
    };
  });

const oauthToken = async (machineId: string, clientId: string, expiresAt: number) => {
  const signer = await prepareIdentitySigner("oauth");
  const { issuer } = await getIdentityRuntimeConfig();
  return new SignJWT({ token_use: "access", client_id: clientId, service_account_id: machineId, scope: "write" })
    .setProtectedHeader({ alg: "RS256", kid: signer.kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience("cloud")
    .setSubject(machineId)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(signer.key);
};

suiteFor(
  "database",
  "nats",
  "valkey",
)("machine group credential lifecycle", () => {
  beforeEach(async () => {
    const [clock] = await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    setSystemTime(clock!.now);
  });
  afterEach(() => setSystemTime());

  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind}: a signed OAuth mutation serializes with client deletion`, async () => {
      const f = await fixture(kind);
      let pending: Promise<Response> | undefined;
      let deletion: Promise<unknown> | undefined;
      try {
        const token = await oauthToken(f.machineId, f.clientId, Math.floor(Date.now() / 1000) + 300);
        // Prove this is an admitted production credential, then restore the empty membership.
        expect((await f.call(token)).status).toBe(200);
        expect((await f.call(token, "DELETE")).status).toBe(200);
        await sql.begin(async (db) => {
          await db`SELECT id FROM auth.groups WHERE id=${f.groupId}::uuid FOR UPDATE`;
          const [holder] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          pending = Promise.resolve(f.call(token));
          const mutationPid = await blockedBy(holder!.pid);
          const started = Promise.withResolvers<number>();
          deletion = sql.begin(async (revoker) => {
            const [row] = await revoker<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            started.resolve(row!.pid);
            await revoker`DELETE FROM oauth.clients WHERE client_id=${f.clientId}`;
          });
          void deletion.catch(started.reject);
          const deletionPid = await started.promise;
          expect(await blockedBy(mutationPid, deletionPid)).toBe(deletionPid);
        });
        expect((await pending!).status).toBe(200);
        await deletion;
        expect(await f.members()).toHaveLength(1);
        expect((await f.call(token, "DELETE")).status).toBe(401);
        expect(await f.members()).toHaveLength(1);
      } finally {
        await Promise.allSettled([pending, deletion]);
        await f.clean();
      }
    });

    for (const credential of ["api key", "OAuth", "updated key"] as const) {
      test(`${kind}: ${credential} expiration is checked after an authorization lock wait`, async () => {
        const f = await fixture(kind);
        let pending: Promise<Response> | undefined;
        try {
          const expiresAt = Math.floor(Date.now() / 1000) + 300;
          let token: string;
          let keyId: string | undefined;
          if (credential === "OAuth") token = await oauthToken(f.machineId, f.clientId, expiresAt);
          else {
            const key = await serviceAccountCredentials.createApiToken({
              serviceAccountId: f.machineId,
              name: "Lifecycle",
              scopes: ["write"],
              expiresAt: new Date(expiresAt * 1000).toISOString(),
            });
            if (!key.ok) throw new Error("Fixture key creation failed");
            token = key.data.token;
            keyId = key.data.credential.id;
          }
          expect((await f.call(token)).status).toBe(200);
          expect((await f.call(token, "DELETE")).status).toBe(200);
          await sql.begin(async (db) => {
            if (credential === "updated key") await db`SELECT id FROM auth.service_accounts WHERE id=${f.machineId}::uuid FOR UPDATE`;
            else await db`SELECT id FROM auth.groups WHERE id=${f.groupId}::uuid FOR UPDATE`;
            const [holder] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            pending = Promise.resolve(f.call(token));
            await blockedBy(holder!.pid);
            // The live row can have a shorter lifetime than the already admitted token snapshot.
            const crossedExpiry = credential === "updated key" ? expiresAt - 120 : expiresAt;
            if (credential === "updated key")
              await db`UPDATE auth.service_account_credentials SET expires_at=${new Date(crossedExpiry * 1000)}
                WHERE id=${keyId!}::uuid`;
            // No real sleep or calendar dependence: authentication has already reached the lock.
            setSystemTime(new Date((crossedExpiry + 1) * 1000));
          });
          expect((await pending!).status).toBe(403);
          expect(await f.members()).toHaveLength(0);
          const denied = await sql`SELECT 1 FROM audit.events
            WHERE target_id=${f.groupId} AND metadata->>'actorServiceAccountId'=${f.machineId} AND outcome='denied'`;
          expect(denied.length).toBeGreaterThan(0);
        } finally {
          try {
            await pending;
          } finally {
            await f.clean();
          }
        }
      });
    }
  }
});
