import { AI_INFERENCE_SCOPE } from "../../contracts/shared";
import type { AccessSubject } from "../../server/services/access";
import { isAccountExpired } from "../account-model";
import { serviceAccountCredentials } from "../service-account-credentials";
import { isStandaloneServiceAccountKind } from "../service-accounts";

export const authenticateModelsOnlyCredential = async (
  token: string | null | undefined,
): Promise<{ subject: AccessSubject; credentialId: string } | null> => {
  if (!token || !serviceAccountCredentials.isApiToken(token)) return null;
  const authenticated = await serviceAccountCredentials.authenticateApiToken(token);
  if (!authenticated) return null;
  const { credential, serviceAccount, delegatedUser } = authenticated;
  if (
    credential.kind !== "api_token" ||
    credential.status !== "active" ||
    credential.serviceAccountId !== serviceAccount.id ||
    serviceAccount.status !== "active" ||
    credential.scopes.length !== 1 ||
    credential.scopes[0] !== AI_INFERENCE_SCOPE
  )
    return null;
  if (isStandaloneServiceAccountKind(serviceAccount.kind)) {
    return { subject: { type: "service_account", serviceAccountId: serviceAccount.id }, credentialId: credential.id };
  }
  if (
    serviceAccount.kind !== "user_delegated" ||
    !delegatedUser ||
    serviceAccount.delegatedUserId !== delegatedUser.id ||
    isAccountExpired(delegatedUser.accountExpires)
  )
    return null;
  return { subject: { type: "user", userId: delegatedUser.id }, credentialId: credential.id };
};
