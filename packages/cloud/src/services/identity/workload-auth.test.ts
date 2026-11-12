import { describe, expect, test } from "bun:test";
import type { ServiceAccountCredential } from "../service-account-credentials";
import type { ServiceAccount } from "../service-accounts";
import { hasReservedWorkloadScope, isReservedWorkloadApiCredential } from "./workload-auth";

const serviceAccount = (overrides: Partial<ServiceAccount> = {}): ServiceAccount => ({
  id: "9fe97b00-1578-42e8-9204-3da0928825f2",
  name: "Reports workload",
  kind: "resource_bound",
  status: "active",
  delegatedUserId: null,
  appId: "reports",
  resourceType: "cloud.app",
  resourceId: "reports",
  createdBy: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  ...overrides,
});

const credential = (overrides: Partial<ServiceAccountCredential> = {}): ServiceAccountCredential => ({
  id: "353d9716-0f6a-4ca2-8ba9-ff9ad6d128b0",
  serviceAccountId: "9fe97b00-1578-42e8-9204-3da0928825f2",
  name: "Reports workload",
  kind: "api_token",
  status: "active",
  tokenPrefix: "0123456789abcdef01234567",
  scopes: ["identity:invoke"],
  expiresAt: null,
  lastUsedAt: null,
  createdBy: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  revokedAt: null,
  revokedBy: null,
  ...overrides,
});

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

  test("reserved invocation and retired OAuth scopes never become ordinary token scopes", () => {
    expect(hasReservedWorkloadScope(["read", "identity:invoke"])).toBe(true);
    expect(hasReservedWorkloadScope(["identity:oauth-issue"])).toBe(true);
    expect(hasReservedWorkloadScope(["read", "write"])).toBe(false);
  });
});
