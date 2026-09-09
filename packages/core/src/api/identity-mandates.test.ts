import { describe, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { CAPABILITY_MAX_REQUEST_BYTES } from "@k2b/cloud/contracts";
import type { Mandate } from "@k2b/cloud/services/mandates";
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
  test("bounds every lifecycle body even with absent or forged Content-Length", async () => {
    let mutations = 0;
    const mutate = async () => {
      mutations += 1;
      return ok(mandate);
    };
    const routes = createIdentityMandateRoutes({
      authenticateWorkload: async ({ appId }) => ({
        appId,
        serviceAccountId: SERVICE_ACCOUNT_ID,
        credentialId: CREDENTIAL_ID,
        scope: "identity:invoke",
      }),
      service: { get: async () => mandate, confirm: mutate, updatePolicy: mutate, pause: mutate, revoke: mutate },
    });
    for (const action of ["confirm", "policy", "pause", "revoke"]) {
      for (const declaredLength of [undefined, "1", String(CAPABILITY_MAX_REQUEST_BYTES + 1)]) {
        let cancelled = false;
        let bytesRead = 0;
        const stream = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              const chunk = new Uint8Array(16 * 1024).fill(32);
              bytesRead += chunk.byteLength;
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        );
        const headers = new Headers({ authorization: "Bearer workload-secret", "x-cloud-app-id": "mail" });
        if (declaredLength !== undefined) headers.set("content-length", declaredLength);
        const response = await routes.request(
          new Request(`http://core.test/mandates/${MANDATE_ID}/${action}`, { method: "POST", headers, body: stream }),
        );
        expect(response.status).toBe(413);
        expect(await response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
        expect(cancelled).toBe(true);
        expect(bytesRead).toBeLessThanOrEqual(CAPABILITY_MAX_REQUEST_BYTES + 16 * 1024);
        if (declaredLength === String(CAPABILITY_MAX_REQUEST_BYTES + 1)) expect(bytesRead).toBe(0);
      }
    }
    expect(mutations).toBe(0);
    const json = JSON.stringify({ expectedRevision: 3 });
    const atLimit = await routes.request(
      new Request(`http://core.test/mandates/${MANDATE_ID}/confirm`, {
        method: "POST",
        headers: { authorization: "Bearer workload-secret", "x-cloud-app-id": "mail", "content-length": "1" },
        body: json + " ".repeat(CAPABILITY_MAX_REQUEST_BYTES - new TextEncoder().encode(json).byteLength),
      }),
    );
    expect(atLimit.status).toBe(200);
    expect(mutations).toBe(1);
  });

  test("authenticates and checks ownership before consuming lifecycle bodies", async () => {
    for (const action of ["confirm", "policy", "pause", "revoke"]) {
      for (const authenticated of [false, true]) {
        let reads = 0;
        const routes = createIdentityMandateRoutes({
          authenticateWorkload: async () =>
            authenticated
              ? { appId: "oauth", serviceAccountId: SERVICE_ACCOUNT_ID, credentialId: CREDENTIAL_ID, scope: "identity:invoke" }
              : null,
          service: {
            get: async () => mandate,
            confirm: async () => ok(mandate),
            updatePolicy: async () => ok(mandate),
            pause: async () => ok(mandate),
            revoke: async () => ok(mandate),
          },
        });
        const stream = new ReadableStream<Uint8Array>(
          {
            pull() {
              reads += 1;
              throw new Error("Unauthorized body was read");
            },
          },
          { highWaterMark: 0 },
        );
        const req = new Request(`http://core.test/mandates/${MANDATE_ID}/${action}`, {
          method: "POST",
          headers: { authorization: "Bearer workload-secret", "x-cloud-app-id": "oauth" },
          body: stream,
        });
        expect((await routes.request(req)).status).toBe(authenticated ? 404 : 401);
        expect(reads).toBe(0);
        expect(req.bodyUsed).toBe(false);
      }
    }
  });

  test("rejects malformed JSON and invalid UTF-8 without executing a mutation", async () => {
    let mutations = 0;
    const mutate = async () => {
      mutations += 1;
      return ok(mandate);
    };
    const routes = createIdentityMandateRoutes({
      authenticateWorkload: async ({ appId }) => ({
        appId,
        serviceAccountId: SERVICE_ACCOUNT_ID,
        credentialId: CREDENTIAL_ID,
        scope: "identity:invoke",
      }),
      service: { get: async () => mandate, confirm: mutate, updatePolicy: mutate, pause: mutate, revoke: mutate },
    });
    for (const body of [new TextEncoder().encode("{"), new Uint8Array([0xff])]) {
      const response = await routes.request(
        new Request(`http://core.test/mandates/${MANDATE_ID}/confirm`, {
          method: "POST",
          headers: { authorization: "Bearer workload-secret", "x-cloud-app-id": "mail" },
          body,
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(mutations).toBe(0);
  });

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
