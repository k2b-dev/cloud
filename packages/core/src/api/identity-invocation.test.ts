import { describe, expect, test } from "bun:test";
import { err, fail, ok } from "@k2b/stdlib";
import type { CapabilityRegistryEntry } from "@valentinkolb/cloud/contracts/registry";
import type { withActiveIdentitySigner } from "@valentinkolb/cloud/services/identity";
import { generateKeyPair } from "jose";
import { sql } from "bun";
import { z } from "zod";
import { createIdentityInvocationRoutes } from "./identity-invocation";

const mandateId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const serviceAccountId = "33333333-3333-4333-8333-333333333333";
const workloadToken = "cld_aaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const schemaHash = "a".repeat(64);
const inputSchema = z.toJSONSchema(z.object({ id: z.string() }).strict()) as Record<string, unknown>;
const dataSchema = z.toJSONSchema(z.object({ id: z.string() }).strict()) as Record<string, unknown>;

const registryEntry: CapabilityRegistryEntry = {
  appId: "spaces",
  appName: "Spaces",
  appIcon: "ti ti-box",
  appDescription: "Spaces app",
  endpoint: "http://spaces:3000/api/_internal/capabilities/v1",
  manifest: {
    protocolVersion: 1,
    appId: "spaces",
    manifestHash: "b".repeat(64),
    types: [],
    queries: [
      {
        localId: "get",
        title: "Get item",
        description: "Get one item.",
        inputSchema,
        dataSchema,
        schemaHash,
        openWorld: false,
      },
    ],
    actions: [],
  },
};

const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://core.test/invoke", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${workloadToken}`,
      "Content-Type": "application/json",
      "X-Cloud-App-Id": "mail",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const invocation = (extra: Record<string, unknown> = {}) => ({
  kind: "query",
  targetApp: "spaces",
  capabilityId: "get",
  input: { id: "one" },
  mandateId,
  mandateRevision: 3,
  metadata: { requestId: "request-7", traceparent: "00-trace", locale: "de" },
  ...extra,
});

const authenticateWorkload = async (input: { token: string | null | undefined; appId: string; scope: "identity:invoke" }) => {
  expect(input).toEqual({ token: workloadToken, appId: "mail", scope: "identity:invoke" });
  return { appId: "mail", serviceAccountId, credentialId: serviceAccountId, scope: "identity:invoke" as const };
};

let signerKey: CryptoKey | undefined;
const withActiveSigner: typeof withActiveIdentitySigner = async (_purpose, callback) => {
  signerKey ??= (await generateKeyPair("RS256")).privateKey;
  return callback(
    {
      kid: "44444444-4444-4444-8444-444444444444",
      key: signerKey,
      signUntil: new Date(Date.now() + 60_000),
      issuer: "https://cloud.example.test",
    },
    sql,
  );
};

describe("identity invocation broker", () => {
  test("keeps the invocation JWT on the Core-to-target hop", async () => {
    const targetRequests: Request[] = [];
    let signed: Record<string, unknown> | null = null;
    const routes = createIdentityInvocationRoutes({
      issuanceEnabled: () => true,
      authenticateWorkload,
      dispatchDependencies: {
        getCapability: async () => registryEntry,
        withActiveSigner,
        withMandateIssueAuthority: async (input, use) => {
          expect(input).toMatchObject({
            mandateId,
            expectedRevision: 3,
            ownerAppId: "mail",
            targetAppId: "spaces",
            operation: "capability.query:get",
            requestId: "request-7",
          });
          return ok(
            await use({
              mandateId,
              mandateRevision: 3,
              subject: { type: "user", id: userId },
              ownerAppId: "mail",
              workloadType: "incoming.automation",
              workloadId: "rule-17",
              targetAppId: "spaces",
              operation: "capability.query:get",
              policy: { version: 1, apps: ["spaces"], operations: ["capability.query:get"], actions: "deny" },
            }),
          );
        },
        signInvocation: async (input) => {
          signed = input;
          return { token: "target-only-invocation", kid: "44444444-4444-4444-8444-444444444444", claims: {} as never };
        },
        fetch: async (input, init) => {
          targetRequests.push(input instanceof Request ? input : new Request(input, init));
          return Response.json({ data: { id: "one" } });
        },
      },
    });

    const response = await routes.request(request(invocation()));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({ data: { id: "one" } });
    expect(JSON.stringify(body)).not.toContain("target-only-invocation");
    expect(signed).toMatchObject({
      targetAppId: "spaces",
      callingAppId: "mail",
      operation: "capability.query:get",
      schemaHash,
      requestId: "request-7",
      authority: {
        sub: userId,
        credential_kind: "mandate",
        mandate_id: mandateId,
        mandate_revision: 3,
      },
    });
    const targetRequest = targetRequests[0];
    expect(targetRequest?.url).toBe("http://spaces:3000/api/_internal/capabilities/v1/queries/get");
    expect(targetRequest?.headers.get("authorization")).toBe("Bearer target-only-invocation");
    expect(targetRequest?.headers.get("authorization")).not.toContain(workloadToken);
    expect(targetRequest?.headers.get("x-cloud-capability-schema-hash")).toBe(schemaHash);
    expect(targetRequest?.headers.get("x-cloud-locale")).toBe("de");
  });

  test("rejects caller-supplied schema or authority fields", async () => {
    let dispatched = false;
    const routes = createIdentityInvocationRoutes({
      issuanceEnabled: () => true,
      authenticateWorkload,
      dispatchDependencies: {
        getCapability: async () => {
          dispatched = true;
          return registryEntry;
        },
      },
    });
    const response = await routes.request(
      request(invocation({ schemaHash: "a".repeat(64), scopes: ["admin"], actor: { sub: userId }, actionApproval: "approved" })),
    );
    expect(response.status).toBe(400);
    expect(dispatched).toBe(false);

    const { input: _input, ...withoutInput } = invocation();
    const missingInput = await routes.request(request(withoutInput));
    expect(missingInput.status).toBe(400);
    expect(dispatched).toBe(false);
  });

  test("rejects invalid credentials before dispatch", async () => {
    let dispatched = false;
    const routes = createIdentityInvocationRoutes({
      issuanceEnabled: () => true,
      authenticateWorkload: async () => null,
      dispatchDependencies: {
        getCapability: async () => {
          dispatched = true;
          return registryEntry;
        },
      },
    });
    const response = await routes.request(request(invocation()));
    expect(response.status).toBe(401);
    expect(dispatched).toBe(false);
  });

  test("returns bounded mandate denial instead of a token", async () => {
    const routes = createIdentityInvocationRoutes({
      issuanceEnabled: () => true,
      authenticateWorkload,
      dispatchDependencies: {
        getCapability: async () => registryEntry,
        withActiveSigner,
        withMandateIssueAuthority: async () => fail(err.forbidden("Mandate is revoked")),
      },
    });
    const response = await routes.request(request(invocation()));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "MANDATE_FORBIDDEN",
      message: "Mandate does not authorize this capability invocation",
    });
  });

  test("stays closed until invocation issuance is enabled", async () => {
    const routes = createIdentityInvocationRoutes({
      issuanceEnabled: () => false,
      authenticateWorkload: async () => {
        throw new Error("disabled issuance must not authenticate workloads");
      },
    });
    const response = await routes.request(request(invocation()));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "INVOCATION_JWT_DISABLED" });
  });
});
