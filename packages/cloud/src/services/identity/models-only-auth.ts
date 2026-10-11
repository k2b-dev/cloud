import { AI_INFERENCE_SCOPE, type User } from "../../contracts/shared";
import { isAccountExpired } from "../account-model";
import { serviceAccountCredentials } from "../service-account-credentials";

export const authenticateModelsOnlyCredential = async (
  token: string | null | undefined,
): Promise<{ user: User; credentialId: string } | null> => {
  if (!token || !serviceAccountCredentials.isApiToken(token)) return null;
  const authenticated = await serviceAccountCredentials.authenticateApiToken(token);
  if (!authenticated) return null;
  const { credential, serviceAccount, delegatedUser } = authenticated;
  if (
    credential.kind !== "api_token" ||
    credential.status !== "active" ||
    credential.serviceAccountId !== serviceAccount.id ||
    serviceAccount.status !== "active" ||
    serviceAccount.kind !== "user_delegated" ||
    !delegatedUser ||
    serviceAccount.delegatedUserId !== delegatedUser.id ||
    !credential.scopes.includes(AI_INFERENCE_SCOPE) ||
    isAccountExpired(delegatedUser.accountExpires)
  )
    return null;
  return { user: delegatedUser, credentialId: credential.id };
};
