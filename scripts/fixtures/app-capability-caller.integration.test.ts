import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { z } from "zod";
import { createAppCapabilityRoutes } from "../../packages/cloud/src/_internal/app-capabilities";
import { compileCapabilities } from "../../packages/cloud/src/_internal/capabilities";
import { deriveAppPublicKey } from "../../packages/cloud/src/app-key";
import { migrateCloudCapabilities } from "../../packages/cloud/src/capabilities/migrate";
import { readCapabilityResponse } from "../../packages/cloud/src/capabilities/response";
import { compileCapabilityManifest } from "../../packages/cloud/src/capabilities/testing";
import { CAPABILITY_MAX_RESULT_BYTES, capabilityResultSchema, defineCapabilities } from "../../packages/cloud/src/contracts";
import type { AppRegistryEntry, CapabilityRegistryEntry } from "../../packages/cloud/src/contracts/registry";
import { signAppProof } from "../../packages/cloud/src/runtime/bootstrap-protocol";
import { sql } from "../../packages/cloud/src/runtime/clients";
import { appKeys, getInstallationId } from "../../packages/cloud/src/services/app-keys";
import { GeoError } from "../../packages/cloud/src/services/geo/errors";
import * as invocation from "../../packages/cloud/src/services/identity/invocation-token";
import { createIdentityInvocationRoutes } from "../../packages/core/src/api/identity-invocation";
import { runGeoQuery } from "../../packages/core/src/geo-capability-result";
import { migrate as migrateAudit } from "../../packages/core/src/migrate/core/audit";
import { migrate as migrateAuth } from "../../packages/core/src/migrate/core/auth";
import { migrate as migrateSettings } from "../../packages/core/src/migrate/core/settings";
import { suiteFor, useFreshDatabase } from "../../scripts/fixtures/test-infra";
import { APP_KEY_FIXTURES } from "./app-key-fixtures";

const now = new Date("2030-01-02T03:04:05Z");
const seed = APP_KEY_FIXTURES[0].seed;
const input = z.object({ text: z.string().max(100).describe("Text to echo.") }).strict();
let calls = 0;
let actions = 0;
const definition = defineCapabilities({
  protocolVersion: 2,
  queries: {
    echo: {
      title: "Echo",
      description: "An app-paid platform fixture.",
      input,
      data: input,
      openWorld: false,
      run: (value) => ({ ok: true, data: { data: value } }),
      app: {
        permission: "geo:query",
        run: (value, context) => {
          calls++;
          expect(context.actor.kind).toBe("app");
          expect(context.accessSubject).toEqual({ type: "none" });
          if (value.text === "exhausted")
            return runGeoQuery(context, async () => {
              throw new GeoError("GEO_BUDGET_EXHAUSTED", { scope: "person", resetsAt: "2030-01-02T03:05:05Z" });
            });
          return { ok: true, data: { data: value } };
        },
      },
    },
  },
  actions: {
    save: {
      title: "Save",
      description: "An app-paid idempotent action.",
      input,
      data: input,
      openWorld: false,
      destructive: false,
      idempotency: "required",
      run: (value) => ({ ok: true, data: { data: value } }),
      app: {
        permission: "geo:query",
        run: (value, context) => {
          actions++;
          expect(context.idempotencyKey).toBe("app-save");
          return { ok: true, data: { data: value } };
        },
      },
    },
  },
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("signed app capability caller through Core", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  const adminId = "11111111-1111-4111-8111-111111111111";
  const admin: Pick<import("../../packages/cloud/src/contracts/shared").User, "id" | "uid" | "provider" | "roles"> = {
    id: adminId,
    uid: "app-capability-admin",
    provider: "local",
    roles: ["admin"],
  };
  beforeAll(async () => {
    setSystemTime(now);
    database = await useFreshDatabase("app_capability_caller");
    await migrateAuth();
    await migrateAudit();
    await migrateSettings();
    await migrateCloudCapabilities();
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${adminId}::uuid,${admin.uid},'local','user',true)`;
  });
  afterAll(async () => {
    setSystemTime();
    await sql.close();
    await database?.drop();
  });

  for (const appId of ["mail", "vendor-web"]) {
    test(`${appId}: permission admission, app/key audit and immediate key revocation`, async () => {
      const registered = await appKeys.register({ actor: admin, appId, publicKey: await deriveAppPublicKey(seed) });
      if (!registered.ok) throw new Error(registered.error.message);
      const appKey = { appId, keyId: registered.data.keyId, installationId: await getInstallationId(), seed };
      const pair = await generateKeyPair("RS256", { extractable: true });
      const signer = {
        kid: "33333333-3333-4333-8333-333333333333",
        key: pair.privateKey,
        issuer: "https://cloud.example.test",
        signUntil: new Date("2030-01-02T04:00:00Z"),
      };
      const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: signer.kid, alg: "RS256", use: "sig" }] });
      const verifyReal = invocation.verifyAppCapabilityInvocation;
      const verifier = spyOn(invocation, "verifyAppCapabilityInvocation").mockImplementation((token, expected) =>
        verifyReal(token, expected, { issuer: signer.issuer, key: jwks, now }),
      );
      let permitted = true;
      let upstream: Request | undefined;
      const provider = new Hono().route("/app-capabilities", createAppCapabilityRoutes(compileCapabilities("core", definition)));
      const manifest = compileCapabilityManifest("core", definition);
      const entry: CapabilityRegistryEntry = {
        appId: "core",
        appName: "Core",
        appDescription: "Fixture",
        appIcon: "ti ti-box",
        endpoint: "http://provider.test",
        manifest,
      };
      const caller: AppRegistryEntry = {
        id: appId,
        name: "Caller",
        description: "Fixture",
        icon: "ti ti-box",
        baseUrl: "http://caller.test",
        routes: [],
        platformPermissions: ["geo:query"],
      };
      const routes = createIdentityInvocationRoutes({
        dispatchDependencies: {
          getCapability: async () => entry,
          getApp: async () => ({ ...caller, platformPermissions: permitted ? caller.platformPermissions : [] }),
          withActiveSigner: async (_purpose, callback) => callback(signer, sql),
          fetch: async (url, init) => {
            upstream = new Request(url, init);
            return provider.fetch(upstream.clone());
          },
        },
      });
      const request = async (kind: "query" | "action" = "query", text = "hello") => {
        const body = JSON.stringify({
          appCaller: true,
          kind,
          targetApp: "core",
          capabilityId: kind === "query" ? "echo" : "save",
          input: { text },
          ...(kind === "action" ? { idempotencyKey: "app-save" } : {}),
          metadata: { requestId: `${appId}-app-call` },
        });
        const proof = await signAppProof(appKey, { method: "POST", path: "/invoke", body: new TextEncoder().encode(body) });
        return routes.request("http://core.test/invoke", {
          method: "POST",
          headers: { authorization: `Bearer ${proof}`, "x-cloud-app-id": appId },
          body,
        });
      };
      try {
        const limited = await request("query", "exhausted");
        expect(limited.status).toBe(429);
        expect(limited.headers.get("Retry-After")).toBe("60");
        expect(
          await readCapabilityResponse(limited, capabilityResultSchema(input, { consumer: true }), CAPABILITY_MAX_RESULT_BYTES),
        ).toMatchObject({ ok: false, error: { code: "GEO_BUDGET_EXHAUSTED", retryAfterMs: 60000 } });
        const start = calls;
        const first = await request();
        expect(await first.clone().json()).toEqual({ data: { text: "hello" } });
        expect(first.status).toBe(200);
        expect(calls).toBe(start + 1);
        const [audit] = await sql<{ actor_kind: string; actor_app_id: string; actor_key_id: string; actor_id: string | null }[]>`
          SELECT actor_kind, actor_app_id, actor_key_id::text, actor_id FROM capabilities.executions WHERE request_id=${`${appId}-app-call`} ORDER BY completed_at DESC LIMIT 1`;
        expect(audit).toEqual({ actor_kind: "app", actor_app_id: appId, actor_key_id: appKey.keyId, actor_id: null });
        const issued = upstream!;
        const actionStart = actions;
        expect((await request("action")).status).toBe(200);
        expect((await request("action")).status).toBe(200);
        expect(actions).toBe(actionStart + 1);
        expect((await request("action", "different input")).status).toBe(409);
        expect(actions).toBe(actionStart + 1);
        const [claim] = await sql<{ principal: string; state: string }[]>`
          SELECT principal, state FROM capabilities.idempotency_claims WHERE principal=${`app:${appId}`}`;
        expect(claim).toEqual({ principal: `app:${appId}`, state: "succeeded" });
        permitted = false;
        expect((await request()).status).toBe(403);
        expect(calls).toBe(start + 1);
        permitted = true;
        expect((await appKeys.revoke({ actor: admin, appId, keyId: appKey.keyId })).ok).toBe(true);
        expect((await request()).status).toBe(401);
        // The provider checks the same durable key state even for an invocation issued before revocation.
        expect((await provider.fetch(issued.clone())).status).toBe(403);
        expect(calls).toBe(start + 1);
      } finally {
        verifier.mockRestore();
      }
    });
  }
});
