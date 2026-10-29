import { expect, setSystemTime, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { redis, sql } from "bun";
import { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { APP_QUERY_REQUESTS_PER_MINUTE, dispatchCapability } from "../api/capabilities";
import * as executions from "../capabilities/executions";
import { type CapabilityAppExecutionContext, type CapabilityExecutionContext, defineCapabilities } from "../contracts/capabilities";
import { signAppQueryInvocation } from "../services/identity/invocation-token";
import { withActiveIdentitySigner } from "../services/identity/key-ring";
import { authenticateWorkloadCredential } from "../services/identity/workload-auth";
import { createApiToken } from "../services/service-account-credentials";
import { createAppQueryRoutes } from "./app-queries";
import { compileCapabilities } from "./capabilities";

suiteFor(
  "database",
  "nats",
  "valkey",
)("app query live admission", () => {
  test("current workload credential is required at authentication and provider execution", async () => {
    const appId = `query-fixture-${crypto.randomUUID()}`;
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
      VALUES ('App query fixture', 'resource_bound', ${appId}, 'cloud.app', ${appId}) RETURNING id`;
    try {
      let invoked = 0;
      const input = z
        .object({ id: z.string().describe("Element ID"), userIds: z.array(z.uuid()).max(500).describe("People to check") })
        .strict();
      const compiled = compileCapabilities(
        "query-provider",
        defineCapabilities({
          protocolVersion: 2,
          queries: {
            readable: {
              title: "Readers",
              description: "Check readers",
              input,
              data: z.object({ readable: z.array(z.uuid()) }).strict(),
              openWorld: false,
              callers: [appId],
              run: async (_: z.output<typeof input>, context: CapabilityExecutionContext | CapabilityAppExecutionContext) => {
                expect(context).toMatchObject({ actor: { kind: "app", appId }, accessSubject: { type: "none" }, user: null });
                invoked++;
                return ok({ data: { readable: [] } });
              },
            },
          },
        }),
      );
      const credential = await createApiToken({ serviceAccountId: account!.id, name: "Query fixture", scopes: ["identity:invoke"] });
      if (!credential.ok) throw new Error(credential.error.message);
      const auth = () => authenticateWorkloadCredential({ appId, scope: "identity:invoke", token: credential.data.token });
      expect(await authenticateWorkloadCredential({ appId, scope: "identity:invoke", token: null })).toBeNull();
      const workload = await auth();
      if (!workload) throw new Error("Missing workload fixture");
      const payload = { id: "Abc123", userIds: [] };
      const signed = await withActiveIdentitySigner("invocation", (signer) =>
        signAppQueryInvocation({
          workload,
          targetAppId: "query-provider",
          capabilityId: "readable",
          schemaHash: compiled.manifest.queries[0]!.schemaHash,
          input: payload,
          requestId: "live-query",
          signer,
        }),
      );
      const routes = createAppQueryRoutes(compiled);
      const call = (token: string | null = signed.token, value: unknown = payload) =>
        routes.request("http://provider.test/readable", {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ input: value }),
        });
      expect((await call()).status).toBe(200);
      expect((await call(null)).status).toBe(403);
      expect((await call("invalid")).status).toBe(403);
      expect((await call(signed.token, { ...payload, userIds: [account!.id] })).status).toBe(403);
      await sql`UPDATE auth.service_account_credentials SET status = 'revoked', revoked_at = clock_timestamp() WHERE id = ${workload.credentialId}::uuid`;
      expect(await auth()).toBeNull();
      expect((await call()).status).toBe(403);
      await sql`UPDATE auth.service_account_credentials SET status = 'active', revoked_at = NULL, expires_at = now() - interval '1 second' WHERE id = ${workload.credentialId}::uuid`;
      expect(await auth()).toBeNull();
      expect((await call()).status).toBe(403);
      await sql`UPDATE auth.service_account_credentials SET expires_at = NULL, scopes = '{}' WHERE id = ${workload.credentialId}::uuid`;
      expect(await auth()).toBeNull();
      expect((await call()).status).toBe(403);
      await sql`UPDATE auth.service_account_credentials SET scopes = ARRAY['identity:invoke'] WHERE id = ${workload.credentialId}::uuid`;
      await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${account!.id}::uuid`;
      expect(await auth()).toBeNull();
      expect((await call()).status).toBe(403);
      await sql`UPDATE auth.service_accounts SET status = 'active', resource_id = 'wrong' WHERE id = ${account!.id}::uuid`;
      expect(await auth()).toBeNull();
      expect((await call()).status).toBe(403);
      expect(invoked).toBe(1);
    } finally {
      await sql`DELETE FROM auth.service_accounts WHERE id = ${account!.id}::uuid`;
    }
  });
  test("execution history persists the app without a person or grant subject", async () => {
    const id = await executions.recordCapabilityExecution({
      requestId: "app-query-history-fixture",
      origin: "app",
      appId: "spaces",
      capability: "spaces.item.readable",
      kind: "query",
      destructive: false,
      actorKind: "app",
      viaAppId: "chat",
      status: "succeeded",
      inputMeta: { type: "object", keys: ["id", "userIds"], omittedKeys: 0 },
      startedAt: new Date("2026-10-29T00:00:00Z"),
      completedAt: new Date("2026-10-29T00:00:00.001Z"),
    });
    try {
      const [row] =
        await sql`SELECT actor_kind, actor_id, user_id, access_subject_type, access_subject_id, via_app_id FROM capabilities.executions WHERE id = ${id}::uuid`;
      expect(row).toEqual({
        actor_kind: "app",
        actor_id: null,
        user_id: null,
        access_subject_type: null,
        access_subject_id: null,
        via_app_id: "chat",
      });
    } finally {
      await sql`DELETE FROM capabilities.executions WHERE id = ${id}::uuid`;
    }
  });
  test("real Valkey budget is shared by target queries for the calling app", async () => {
    setSystemTime(new Date("2026-10-29T00:00:00Z"));
    const appId = `rate-fixture-${crypto.randomUUID()}`;
    const window = Math.floor(Date.now() / 60_000);
    const keys = [window - 1, window].map((part) => `cloud:ratelimit:app-queries:${appId}:${part}`);
    const record = spyOn(executions, "recordCapabilityExecution").mockResolvedValue(crypto.randomUUID());
    try {
      const compiled = compileCapabilities(
        "provider",
        defineCapabilities({
          protocolVersion: 2,
          queries: {
            readers: {
              title: "Readers",
              description: "Readers",
              input: z.object({ missing: z.string().describe("Required value") }).strict(),
              data: z.object({}).strict(),
              openWorld: false,
              callers: [appId],
              run: async () => ok({ data: {} }),
            },
          },
        }),
      );
      await redis.set(keys[1]!, String(APP_QUERY_REQUESTS_PER_MINUTE - 1));
      const call = (target: string) =>
        dispatchCapability({
          request: new Request("http://core.test/invoke"),
          workload: { appId, credentialId: crypto.randomUUID(), serviceAccountId: crypto.randomUUID(), scope: "identity:invoke" },
          kind: "queries",
          appId: target,
          capabilityId: "readers",
          input: {},
          origin: "app",
          dependencies: {
            getApp: async (id) => ({ id, name: id, description: "", icon: "", routes: [], baseUrl: "http://caller.test" }),
            getCapability: async () => ({
              appId: target,
              appName: "Provider",
              appDescription: "Fixture",
              appIcon: "ti ti-box",
              endpoint: "http://provider.test",
              manifest: { ...compiled.manifest, appId: target },
            }),
            // Deliberately stop at input validation: admission already consumed the actual shared rate budget.
          },
        });
      // A validation failure still consumes its admitted slot; no signer or network is needed.
      expect((await call("provider")).status).toBe(400);
      expect((await call("other-provider")).status).toBe(429);
    } finally {
      await redis.del(...keys);
      record.mockRestore();
      setSystemTime();
    }
  });
});
