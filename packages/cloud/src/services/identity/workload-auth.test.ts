import { describe, expect, test } from "bun:test";
import type { AuthenticatedServiceAccountCredential, ServiceAccountCredential } from "../service-account-credentials";
import type { ServiceAccount } from "../service-accounts";
import { authenticateWorkloadCredential, isReservedWorkloadApiCredential, type WorkloadScope } from "./workload-auth";

const token = "cld_0123456789abcdef01234567_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const serviceAccount = (overrides: Partial<ServiceAccount> = {}): ServiceAccount => ({
  id: "9fe97b00-1578-42e8-9204-3da0928825f2",
  name: "OAuth workload",
  kind: "resource_bound",
  status: "active",
  delegatedUserId: null,
  appId: "oauth",
  resourceType: "cloud.app",
  resourceId: "oauth",
  createdBy: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  ...overrides,
});

const credential = (overrides: Partial<ServiceAccountCredential> = {}): ServiceAccountCredential => ({
  id: "353d9716-0f6a-4ca2-8ba9-ff9ad6d128b0",
  serviceAccountId: "9fe97b00-1578-42e8-9204-3da0928825f2",
  name: "OAuth workload",
  kind: "api_token",
  status: "active",
  tokenPrefix: "0123456789abcdef01234567",
  scopes: ["identity:oauth-issue"],
  expiresAt: null,
  lastUsedAt: null,
  createdBy: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  revokedAt: null,
  revokedBy: null,
  ...overrides,
});

const authenticator = (result: AuthenticatedServiceAccountCredential | null, options: { acceptsToken?: boolean } = {}) => {
  let calls = 0;
  return {
    credentials: {
      isApiToken: () => options.acceptsToken ?? true,
      authenticateApiToken: async () => {
        calls += 1;
        return result;
      },
    },
    calls: () => calls,
  };
};

const authenticate = (
  result: AuthenticatedServiceAccountCredential | null,
  overrides: { token?: string | null; appId?: string; scope?: WorkloadScope } = {},
) => {
  const fake = authenticator(result);
  return authenticateWorkloadCredential({
    token: overrides.token === undefined ? token : overrides.token,
    appId: overrides.appId ?? "oauth",
    scope: overrides.scope ?? "identity:oauth-issue",
    credentials: fake.credentials,
  });
};

describe("Cloud app workload authentication", () => {
  test("identifies both reserved scopes only on resource-bound credentials", () => {
    for (const scope of ["identity:invoke", "identity:oauth-issue"] as const) {
      expect(
        isReservedWorkloadApiCredential({
          credential: credential({ scopes: [scope] }),
          serviceAccount: serviceAccount(),
          delegatedUser: null,
        }),
      ).toBeTrue();
    }
    expect(
      isReservedWorkloadApiCredential({
        credential: credential({ scopes: ["read"] }),
        serviceAccount: serviceAccount(),
        delegatedUser: null,
      }),
    ).toBeFalse();
    expect(
      isReservedWorkloadApiCredential({
        credential: credential({ scopes: ["identity:invoke"] }),
        serviceAccount: serviceAccount({ kind: "user_delegated" }),
        delegatedUser: null,
      }),
    ).toBeFalse();
  });

  test("accepts an active, exactly bound workload with the required scope", async () => {
    const authenticated = { credential: credential(), serviceAccount: serviceAccount(), delegatedUser: null };

    expect(await authenticate(authenticated)).toEqual({
      appId: "oauth",
      serviceAccountId: authenticated.serviceAccount.id,
      credentialId: authenticated.credential.id,
      scope: "identity:oauth-issue",
    });

    const invocation = {
      ...authenticated,
      credential: credential({ scopes: ["identity:invoke"] }),
      serviceAccount: serviceAccount({ appId: "assistant", resourceId: "assistant" }),
    };
    expect(await authenticate(invocation, { appId: "assistant", scope: "identity:invoke" })).toMatchObject({
      appId: "assistant",
      scope: "identity:invoke",
    });
  });

  test("rejects missing and non-cld credentials before secret verification", async () => {
    const fake = authenticator(null, { acceptsToken: false });

    expect(
      await authenticateWorkloadCredential({
        token: "ey.invalid.jwt",
        appId: "oauth",
        scope: "identity:oauth-issue",
        credentials: fake.credentials,
      }),
    ).toBeNull();
    expect(
      await authenticateWorkloadCredential({
        token: null,
        appId: "oauth",
        scope: "identity:oauth-issue",
        credentials: fake.credentials,
      }),
    ).toBeNull();
    expect(fake.calls()).toBe(0);
  });

  test("rejects inactive, delegated, and mismatched workload identities", async () => {
    const base = { credential: credential(), serviceAccount: serviceAccount(), delegatedUser: null };
    const invalid = [
      { ...base, credential: credential({ status: "revoked" }) },
      { ...base, credential: credential({ serviceAccountId: "356b1fd8-1763-4900-a9d6-60cbcb1e54d8" }) },
      { ...base, serviceAccount: serviceAccount({ status: "disabled" }) },
      {
        ...base,
        serviceAccount: serviceAccount({ kind: "user_delegated", delegatedUserId: "356b1fd8-1763-4900-a9d6-60cbcb1e54d8" }),
      },
      { ...base, serviceAccount: serviceAccount({ delegatedUserId: "356b1fd8-1763-4900-a9d6-60cbcb1e54d8" }) },
      { ...base, serviceAccount: serviceAccount({ appId: "mail" }) },
      { ...base, serviceAccount: serviceAccount({ resourceType: "mailbox" }) },
      { ...base, serviceAccount: serviceAccount({ resourceId: "mail" }) },
    ];

    for (const candidate of invalid) expect(await authenticate(candidate)).toBeNull();
  });

  test("requires the exact dedicated scope and a non-empty expected app", async () => {
    const base = { credential: credential(), serviceAccount: serviceAccount(), delegatedUser: null };
    expect(await authenticate({ ...base, credential: credential({ scopes: [] }) })).toBeNull();
    expect(await authenticate({ ...base, credential: credential({ scopes: ["identity:oauth-issue:extra"] }) })).toBeNull();
    expect(await authenticate(base, { appId: " " })).toBeNull();
    expect(await authenticate(base, { appId: " oauth " })).toBeNull();
    expect(
      await authenticateWorkloadCredential({
        token,
        appId: "oauth",
        scope: "identity:other" as WorkloadScope,
        credentials: authenticator(base).credentials,
      }),
    ).toBeNull();
  });

  test("returns null when the current credential lookup denies access", async () => {
    expect(await authenticate(null)).toBeNull();
  });
});
