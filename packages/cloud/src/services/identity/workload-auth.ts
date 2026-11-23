import type { AuthenticatedServiceAccountCredential } from "../service-account-credentials";

export const WORKLOAD_SCOPES = ["identity:invoke"] as const;

export type WorkloadScope = (typeof WORKLOAD_SCOPES)[number];

export type AuthenticatedWorkload = {
  appId: string;
  serviceAccountId: string;
  credentialId: string;
  scope: WorkloadScope;
  /** The verified app key; workload identity has no bearer-token alternative. */
  keyId?: string;
};

const NO_CREDENTIAL = "00000000-0000-0000-0000-000000000000";

/**
 * Core's own app queries. Core is the invocation signer and holds no app key; app keys can never be enrolled
 * for `core`, so only Core can produce a query token with this subject.
 */
export const CORE_WORKLOAD: AuthenticatedWorkload = Object.freeze({
  appId: "core",
  serviceAccountId: NO_CREDENTIAL,
  credentialId: NO_CREDENTIAL,
  scope: "identity:invoke",
});

const workloadScopes = new Set<string>(WORKLOAD_SCOPES);

// Retired OAuth credentials must not become ordinary API keys after the hard cut.
export const hasReservedWorkloadScope = (scopes: readonly string[]): boolean =>
  scopes.some((scope) => workloadScopes.has(scope) || scope === "identity:oauth-issue");

export const isReservedWorkloadApiCredential = (authenticated: AuthenticatedServiceAccountCredential): boolean =>
  authenticated.serviceAccount.kind === "resource_bound" && hasReservedWorkloadScope(authenticated.credential.scopes);
