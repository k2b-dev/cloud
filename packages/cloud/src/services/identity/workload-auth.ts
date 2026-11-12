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

const workloadScopes = new Set<string>(WORKLOAD_SCOPES);

// Retired OAuth credentials must not become ordinary API keys after the hard cut.
export const hasReservedWorkloadScope = (scopes: readonly string[]): boolean =>
  scopes.some((scope) => workloadScopes.has(scope) || scope === "identity:oauth-issue");

export const isReservedWorkloadApiCredential = (authenticated: AuthenticatedServiceAccountCredential): boolean =>
  authenticated.serviceAccount.kind === "resource_bound" && hasReservedWorkloadScope(authenticated.credential.scopes);
