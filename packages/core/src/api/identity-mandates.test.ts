import { describe, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import type { Mandate } from "@valentinkolb/cloud/services/mandates";
import { createIdentityMandateRoutes } from "./identity-mandates";

const MANDATE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL_ID = "44444444-4444-4444-8444-444444444444";

const mandate: Mandate = {
  id: MANDATE_ID,
  subject: { type: "user", id: USER_ID },
  ownerAppId: "mail",
  workloadType: "incoming.automation",
  workloadId: "automation-1",
  policy: { version: 1, apps: ["spaces"], operations: ["capability.query:item.read"], actions: "deny" },
  state: "active",
  revision: 3,
  expiresAt: null,
  confirmedAt: null,
  confirmationDeadline: "2026-09-02T12:15:00.000Z",
  createdByUserId: USER_ID,
  createdAt: "2026-09-02T12:00:00.000Z",
  updatedAt: "2026-09-02T12:00:00.000Z",
  revokedAt: null,
  revokedByUserId: null,
  revokedByAppId: null,
  revokeReason: null,
};

const request = (path: string, method = "GET", body?: unknown, appId = "mail") =>
  new Request(`http://core.test${path}`, {
    method,
    headers: {
      authorization: "Bearer workload-secret",
      "x-cloud-app-id": appId,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("owner mandate lifecycle routes", () => {
  test("requires an app-bound workload and hides another owner's mandate", async () => {
    const authenticated: string[] = [];
    const routes = createIdentityMandateRoutes({
      authenticateWorkload: async (input) => {
        authenticated.push(`${input.appId}:${input.scope}:${input.token}`);
        return {
          appId: input.appId,
          serviceAccountId: SERVICE_ACCOUNT_ID,
          credentialId: CREDENTIAL_ID,
          scope: "identity:invoke",
        };
      },
      service: {
        get: async () => mandate,
        confirm: async () => ok(mandate),
        updatePolicy: async () => ok(mandate),
        pause: async () => ok(mandate),
        revoke: async () => ok(mandate),
      },
    });

    expect((await routes.request(request(`/mandates/${MANDATE_ID}`))).status).toBe(200);
    expect((await routes.request(request(`/mandates/${MANDATE_ID}`, "GET", undefined, "oauth"))).status).toBe(404);
    expect(authenticated).toEqual(["mail:identity:invoke:workload-secret", "oauth:identity:invoke:workload-secret"]);
  });

  test("derives owner authority from authentication for confirm, narrow, pause and revoke", async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const routes = createIdentityMandateRoutes({
      authenticateWorkload: async ({ appId }) => ({
        appId,
        serviceAccountId: SERVICE_ACCOUNT_ID,
        credentialId: CREDENTIAL_ID,
        scope: "identity:invoke",
      }),
      service: {
        get: async () => mandate,
        confirm: async (input) => {
          calls.push({ action: "confirm", input });
          return ok({ ...mandate, confirmedAt: "2026-09-02T12:01:00.000Z", confirmationDeadline: null });
        },
        updatePolicy: async (input) => {
          calls.push({ action: "policy", input });
          return ok(mandate);
        },
        pause: async (input) => {
          calls.push({ action: "pause", input });
          return ok({ ...mandate, state: "paused" });
        },
        revoke: async (input) => {
          calls.push({ action: "revoke", input });
          return ok({ ...mandate, state: "revoked" });
        },
      },
    });

    const expectedRevision = { expectedRevision: 3 };
    expect((await routes.request(request(`/mandates/${MANDATE_ID}/confirm`, "POST", expectedRevision))).status).toBe(200);
    expect(
      (
        await routes.request(
          request(`/mandates/${MANDATE_ID}/policy`, "POST", {
            ...expectedRevision,
            policy: { version: 1, apps: ["spaces"], operations: ["capability.query:item.read"], actions: "deny" },
          }),
        )
      ).status,
    ).toBe(200);
    expect((await routes.request(request(`/mandates/${MANDATE_ID}/pause`, "POST", expectedRevision))).status).toBe(200);
    expect(
      (await routes.request(request(`/mandates/${MANDATE_ID}/revoke`, "POST", { ...expectedRevision, reason: "Workload deleted" }))).status,
    ).toBe(200);

    for (const call of calls) {
      expect(call.input).toMatchObject({
        mandateId: MANDATE_ID,
        expectedRevision: 3,
        authority: { kind: "workload", ownerAppId: "mail" },
      });
    }
    expect(calls.map(({ action }) => action)).toEqual(["confirm", "policy", "pause", "revoke"]);
  });
});
