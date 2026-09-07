import { type AuthenticatedServiceAccountCredential, serviceAccountCredentials } from "../service-account-credentials";

export const WORKLOAD_SCOPES = ["identity:invoke"] as const;

export type WorkloadScope = (typeof WORKLOAD_SCOPES)[number];

export type AuthenticatedWorkload = {
  appId: string;
  serviceAccountId: string;
  credentialId: string;
  scope: WorkloadScope;
};

type WorkloadCredentialAuthenticator = Pick<typeof serviceAccountCredentials, "isApiToken" | "authenticateApiToken">;

const workloadScopes = new Set<string>(WORKLOAD_SCOPES);

// Retired OAuth credentials must not become ordinary API keys after the hard cut.
export const hasReservedWorkloadScope = (scopes: readonly string[]): boolean =>
  scopes.some((scope) => workloadScopes.has(scope) || scope === "identity:oauth-issue");

export const isReservedWorkloadApiCredential = (authenticated: AuthenticatedServiceAccountCredential): boolean =>
  authenticated.serviceAccount.kind === "resource_bound" && hasReservedWorkloadScope(authenticated.credential.scopes);

/** Resolve one app workload credential without exposing or retaining its raw token. */
export const authenticateWorkloadCredential = async (params: {
  token: string | null | undefined;
  appId: string;
  scope: WorkloadScope;
  credentials?: WorkloadCredentialAuthenticator;
}): Promise<AuthenticatedWorkload | null> => {
  const appId = params.appId;
  if (!appId || appId !== appId.trim() || !workloadScopes.has(params.scope)) return null;

  const credentials = params.credentials ?? serviceAccountCredentials;
  if (!params.token || !credentials.isApiToken(params.token)) return null;

  const authenticated: AuthenticatedServiceAccountCredential | null = await credentials.authenticateApiToken(params.token);
  if (!authenticated) return null;

  const { credential, serviceAccount } = authenticated;
  if (
    credential.kind !== "api_token" ||
    credential.status !== "active" ||
    credential.serviceAccountId !== serviceAccount.id ||
    serviceAccount.status !== "active" ||
    serviceAccount.kind !== "resource_bound" ||
    serviceAccount.delegatedUserId !== null ||
    authenticated.delegatedUser !== null ||
    serviceAccount.appId !== appId ||
    serviceAccount.resourceType !== "cloud.app" ||
    serviceAccount.resourceId !== appId ||
    !credential.scopes.includes(params.scope)
  ) {
    return null;
  }

  return {
    appId,
    serviceAccountId: serviceAccount.id,
    credentialId: credential.id,
    scope: params.scope,
  };
};
