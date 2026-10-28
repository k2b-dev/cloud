import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { accounts, serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { prepareIdentitySigner } from "@k2b/cloud/services/identity/key-ring";
import { getIdentityRuntimeConfig } from "@k2b/cloud/services/identity/runtime-config";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { SignJWT } from "jose";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import routes from "./service-accounts";

const suite = suiteFor("database", "nats", "valkey");
suite("machine key administration", () => {
  beforeEach(async () => {
    const [clock] = await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    setSystemTime(clock!.now);
  });
  afterEach(() => setSystemTime());
  for (const kind of ["standalone", "agent"] as const)
    test(`${kind}: key revocation retains the administrator credential ceiling`, async () => {
      const suffix = crypto.randomUUID();
      const [row] = await sql<
        { id: string; auth_epoch: string }[]
      >`INSERT INTO auth.users(uid,provider,profile,admin) VALUES (${`models-admin-${suffix}`},'local','user',true) RETURNING id,auth_epoch`;
      const created = await serviceAccounts.createStandalone({ name: `Model worker ${suffix}`, kind, createdBy: row!.id });
      if (!created.ok) throw new Error("Fixture account failed");
      try {
        const actor = await accounts.users.get({ id: row!.id });
        if (!actor) throw new Error("Fixture administrator missing");
        const signer = await prepareIdentitySigner("oauth");
        const { issuer } = await getIdentityRuntimeConfig();
        const token = async (scope: string) =>
          new SignJWT({ token_use: "access", client_id: "cloud-cli", id: actor.id, auth_epoch: Number(row!.auth_epoch), scope })
            .setProtectedHeader({ alg: "RS256", kid: signer.kid, typ: "JWT" })
            .setIssuer(issuer)
            .setAudience("cloud")
            .setSubject(actor.id)
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(signer.key);
        const readHeaders = { authorization: `Bearer ${await token("read")}` };
        expect((await routes.request("/", { headers: readHeaders })).status).toBe(200);
        const session = await createTestSession(actor.id);
        for (const authority of ["write", "admin", "session"]) {
          const key = await serviceAccountCredentials.createStandaloneApiToken({
            actor,
            serviceAccountId: created.data.id,
            name: "Model inference",
            access: "models",
          });
          if (!key.ok) throw new Error("Fixture key failed");
          const path = `/credentials/${key.data.credential.id}`;
          expect((await routes.request(path, { method: "DELETE", headers: readHeaders })).status).toBe(403);
          expect((await serviceAccountCredentials.getOverview({ id: key.data.credential.id }))?.status).toBe("active");
          const headers: Record<string, string> =
            authority === "session" ? { cookie: `session_token=${session}` } : { authorization: `Bearer ${await token(authority)}` };
          expect((await routes.request(path, { method: "DELETE", headers })).status).toBe(200);
          expect((await serviceAccountCredentials.getOverview({ id: key.data.credential.id }))?.status).toBe("revoked");
        }
      } finally {
        await sql`DELETE FROM auth.service_accounts WHERE id=${created.data.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${row!.id}::uuid`;
      }
    });
});
