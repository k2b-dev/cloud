import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { decodeJwt } from "jose";
import { compileReviewFixture } from "../../../packages/cloud/src/_internal/capability-review.test-fixture";
import { createMeMandateRoutes } from "../../../packages/cloud/src/api/me";
import type { CapabilityActionPolicy } from "../../../packages/cloud/src/contracts/capabilities";
import { auth } from "../../../packages/cloud/src/server";
import { mandates } from "../../../packages/cloud/src/services/mandates";
import { toPgTextArray } from "../../../packages/cloud/src/services/postgres";
import { serviceAccountCredentials } from "../../../packages/cloud/src/services/service-account-credentials";
import { createTestSession } from "../../../packages/cloud/src/services/session/session.test-fixture";
import { useTestSettings } from "../../../packages/cloud/src/services/settings/settings.test-fixture";
import { createIdentityInvocationRoutes } from "../../../packages/core/src/api/identity-invocation";
import { createIdentityMandateRoutes } from "../../../packages/core/src/api/identity-mandates";
import { useTestAppRegistry } from "../../../scripts/fixtures/app-registry";

const suite = suiteFor("database", "nats", "valkey");

suite("mandate capability policy through self-service and broker routes", () => {
  useTestAppRegistry(["mail", "demo"]);
  useTestSettings({ "app.url": "http://localhost:3000" });
  const userId = crypto.randomUUID();
  const serviceAccountId = crypto.randomUUID();
  const mandateIds: string[] = [];
  let sessionToken = "";
  let workloadToken = "";
  let policy: CapabilityActionPolicy | null = { silent: "you" };
  const targetRequests: Request[] = [];
  const me = new Hono().route("/api/me", createMeMandateRoutes(mandates, auth.requireRole("authenticated")));
  const broker = createIdentityInvocationRoutes({
    dispatchDependencies: {
      getCapability: async () => ({
        appId: "demo",
        appName: "Demo",
        appIcon: "ti ti-test-pipe",
        appDescription: "Test provider",
        endpoint: "http://demo.test/api/_internal/capabilities/v1",
        manifest: compileReviewFixture(policy).manifest,
      }),
      fetch: async (input, init) => {
        targetRequests.push(new Request(input, init));
        return Response.json({ data: {} });
      },
    },
  });
  const lifecycle = createIdentityMandateRoutes();

  beforeAll(async () => {
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, mail)
      VALUES (${userId}::uuid, ${`mandate-policy-${userId}`}, 'local', 'user', 'Policy fixture', 'policy@example.test')`;
    await sql`INSERT INTO auth.service_accounts (id, name, kind, app_id, resource_type, resource_id, created_by)
      VALUES (${serviceAccountId}::uuid, 'Policy workload', 'resource_bound', 'mail', 'cloud.app', 'mail', ${userId}::uuid)`;
    const created = await serviceAccountCredentials.createApiToken({
      serviceAccountId,
      name: "Policy fixture",
      scopes: ["identity:invoke"],
    });
    if (!created.ok) throw new Error(created.error.message);
    workloadToken = created.data.token;
    sessionToken = await createTestSession(userId);
  });

  afterAll(async () => {
    await sql`DELETE FROM audit.events WHERE target_type = 'mandate' AND target_id = ANY(${toPgTextArray(mandateIds)}::text[])`;
    await sql`DELETE FROM capabilities.executions WHERE user_id = ${userId}::uuid`;
    await sql`DELETE FROM capabilities.idempotency_claims WHERE principal = ${`user:${userId}`}`;
    await sql`DELETE FROM auth.mandates WHERE subject_user_id = ${userId}::uuid`;
    await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  for (const { hasGrants, actions } of [
    { hasGrants: false, actions: "preapproved" },
    { hasGrants: true, actions: "preapproved" },
    { hasGrants: false, actions: "require_approval" },
  ] as const) {
    test(`${hasGrants ? "with" : "without"} grants / ${actions} follows the live policy`, async () => {
      const createdResponse = await me.request("http://localhost:3000/api/me/mandates", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `session_token=${sessionToken}` },
        body: JSON.stringify({
          ownerAppId: "mail",
          workloadType: "policy.fixture",
          workloadId: `${userId}-${hasGrants}-${actions}`,
          policy: {
            version: 1,
            apps: ["demo"],
            operations: ["capability.action.run:send"],
            actions,
            ...(hasGrants ? { grants: [{ appId: "demo", capabilityId: "send", kind: "action", fixedInput: {} }] } : {}),
          },
        }),
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json();
      const mandate = await mandates.get(created.id);
      if (!mandate) throw new Error("Created mandate is missing");
      mandateIds.push(mandate.id);
      expect(mandate.confirmedAt).toBeNull();
      expect(mandate.policy.grants === undefined).toBe(!hasGrants);
      const invoke = (key: string, revision = mandate.revision) =>
        broker.request("/invoke", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${workloadToken}`, "x-cloud-app-id": "mail" },
          body: JSON.stringify({
            kind: "action",
            targetApp: "demo",
            capabilityId: "send",
            input: {},
            mandateId: mandate.id,
            mandateRevision: revision,
            idempotencyKey: `${mandate.id}-${key}`,
          }),
        });
      policy = { silent: "you" };
      const before = targetRequests.length;
      expect((await invoke("pending")).status).toBe(403);
      expect(targetRequests.length).toBe(before);
      const confirmedResponse = await lifecycle.request(`/mandates/${mandate.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${workloadToken}`, "x-cloud-app-id": "mail" },
        body: JSON.stringify({ expectedRevision: mandate.revision }),
      });
      expect(confirmedResponse.status).toBe(200);
      const confirmed = await mandates.get(mandate.id);
      if (!confirmed) throw new Error("Confirmed mandate is missing");
      if (actions === "require_approval") {
        expect((await invoke("no-approval", confirmed.revision)).status).toBe(403);
        expect(targetRequests.length).toBe(before);
        return;
      }
      for (const restricted of [{ ask: "sends" }, { silent: "you", routines: false }] as const) {
        policy = restricted;
        const denied = await invoke("same-input", confirmed.revision);
        expect(denied.status).toBe(403);
        expect(await denied.json()).toMatchObject({ code: "MANDATE_FORBIDDEN" });
        expect(targetRequests.length).toBe(before);
      }
      // A rejected attempt must not claim idempotency or prevent a later permitted call.
      for (const allowed of [{ silent: "you" }, null] as const) {
        policy = allowed;
        const response = await invoke(allowed ? "same-input" : "legacy", confirmed.revision);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ data: {} });
      }
      expect(targetRequests.length).toBe(before + 2);
      const token = targetRequests
        .at(-1)
        ?.headers.get("authorization")
        ?.replace(/^Bearer /, "");
      if (!token) throw new Error("Target invocation is missing");
      expect(token).not.toBe(workloadToken);
      expect(decodeJwt(token)).toMatchObject({ credential_kind: "mandate", mandate_id: mandate.id, op: "capability.action.run:send" });
    }, 20_000);
  }
});
