import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { accounts, serviceAccounts } from "@k2b/cloud/services";
import { prepareIdentitySigner } from "@k2b/cloud/services/identity/key-ring";
import { getIdentityRuntimeConfig } from "@k2b/cloud/services/identity/runtime-config";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { SignJWT } from "jose";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { MachineRights } from "./machine-contracts";
import { machineApi } from "./machine-api";
import { machineAccess } from "./machine-service";
import { type ArtifactIdentity, artifacts } from "./service";

suiteFor("database", "nats", "valkey")("Studio machine management credentials", () => {
  beforeEach(async () => {
    const [clock] = await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    setSystemTime(clock!.now);
  });
  afterEach(() => setSystemTime());

  for (const kind of ["agent", "standalone"] as const) {
    for (const administrative of [false, true]) {
      test(`${kind}: ${administrative ? "installation administrator" : "app manager"} uses admin OAuth or a session to manage rights and secrets`, async () => {
        const suffix = crypto.randomUUID();
        const [ownerRow] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile)
          VALUES(${`studio-owner-${suffix}`},'local','user') RETURNING id`;
        const [managerRow] = await sql<{ id: string; auth_epoch: string }[]>`INSERT INTO auth.users(uid,provider,profile,admin)
          VALUES(${`studio-manager-${suffix}`},'local','user',${administrative}) RETURNING id,auth_epoch`;
        const created = await serviceAccounts.createStandalone({ name: `Studio ${kind} ${suffix}`, kind });
        if (!created.ok) throw new Error("Machine fixture creation failed");
        let artifactId: string | undefined;
        const owner = await accounts.users.get({ id: ownerRow!.id });
        if (!owner) throw new Error("Owner fixture missing");
        const ownerIdentity: ArtifactIdentity = { actor: { kind: "user", user: owner }, accessSubject: { type: "user", userId: owner.id } };
        try {
          const resource = await artifacts.create(
            { title: "Machine management credentials", source: { entry: "main.ts", files: [{ path: "main.ts", content: "export default () => 1" }] } },
            ownerIdentity,
          );
          artifactId = resource.id;
          if (!administrative) await artifacts.grant(resource.id, { type: "user", userId: managerRow!.id }, "admin", ownerIdentity);
          const grant = await artifacts.grant(resource.id, { type: "service_account", serviceAccountId: created.data.id }, "read", ownerIdentity);
          if (!grant) throw new Error("Machine grant missing");
          const initial = await machineAccess.save(resource.id, grant.id, { rights: MachineRights.parse({}), expectedRevision: null }, ownerIdentity);
          const secret = await machineAccess.saveSecret(
            resource.id,
            { name: "reportApi", origin: "https://api.example.com", header: "authorization", prefix: "Bearer ", value: "fixture-only", expectedRevision: null },
            ownerIdentity,
          );
          const signer = await prepareIdentitySigner("oauth");
          const { issuer } = await getIdentityRuntimeConfig();
          const token = (scope: string) => new SignJWT({
            token_use: "access", client_id: "cloud-cli", id: managerRow!.id, auth_epoch: Number(managerRow!.auth_epoch), scope,
          }).setProtectedHeader({ alg: "RS256", kid: signer.kid, typ: "JWT" })
            .setIssuer(issuer).setAudience("cloud").setSubject(managerRow!.id).setIssuedAt().setExpirationTime("5m").sign(signer.key);
          const query = administrative ? "?administrative=true" : "";
          const request = (headers: Record<string, string>, method: string, path: string, body?: unknown) => machineApi.request(`/${resource.id}/${path}${query}`, {
            method, headers: { ...headers, "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          const rights = MachineRights.parse({ execute: true, storage: "write", database: "write", secrets: ["reportApi"], http: [{ origin: "https://api.example.com", methods: ["GET"] }], sharing: true });
          const replacement = { name: "reportApi", origin: "https://api.example.com", header: "authorization", prefix: "Bearer ", value: "replacement-only", expectedRevision: secret.revision };
          for (const scope of ["read", "write"]) {
            const headers = { authorization: `Bearer ${await token(scope)}` };
            expect((await request(headers, "GET", "access")).status).toBe(200);
            expect((await request(headers, "GET", "secrets")).status).toBe(200);
            expect((await request(headers, "PUT", `access/${grant.id}`, { rights, expectedRevision: initial.revision })).status).toBe(403);
            expect((await request(headers, "PUT", "secrets", replacement)).status).toBe(403);
            expect((await request(headers, "DELETE", "secrets/reportApi", { revision: secret.revision })).status).toBe(403);
            expect((await machineAccess.list(resource.id, ownerIdentity)).find((entry) => entry.entry.id === grant.id)).toMatchObject({ rights: initial.rights, revision: initial.revision });
            expect(await machineAccess.secretList(resource.id, ownerIdentity)).toEqual([secret]);
          }
          const session = await createTestSession(managerRow!.id);
          const authorizedHeaders: Record<string, string>[] = [{ authorization: `Bearer ${await token("admin")}` }, { cookie: `session_token=${session}` }];
          for (const headers of authorizedHeaders) {
            const policy = (await machineAccess.list(resource.id, ownerIdentity)).find((entry) => entry.entry.id === grant.id)!;
            expect((await request(headers, "PUT", `access/${grant.id}`, { rights, expectedRevision: policy.revision })).status).toBe(200);
            expect((await machineAccess.list(resource.id, ownerIdentity)).find((entry) => entry.entry.id === grant.id)?.rights).toEqual(rights);
            const current = (await machineAccess.secretList(resource.id, ownerIdentity))[0];
            expect((await request(headers, "PUT", "secrets", { ...replacement, expectedRevision: current?.revision ?? null })).status).toBe(200);
            const saved = (await machineAccess.secretList(resource.id, ownerIdentity))[0]!;
            expect(saved.revision).not.toBe(current?.revision);
            expect((await request(headers, "DELETE", "secrets/reportApi", { revision: saved.revision })).status).toBe(200);
            expect(await machineAccess.secretList(resource.id, ownerIdentity)).toEqual([]);
          }
        } finally {
          if (artifactId) await artifacts.remove(artifactId, ownerIdentity);
          await sql`DELETE FROM auth.service_accounts WHERE id=${created.data.id}::uuid`;
          await sql`DELETE FROM auth.users WHERE id IN (${ownerRow!.id}::uuid,${managerRow!.id}::uuid)`;
        }
      });
    }
  }
});
