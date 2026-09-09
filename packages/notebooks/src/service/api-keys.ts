import type { User } from "@k2b/cloud/contracts";
import { type ServiceAccount, serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import {
  ensureNotebookServiceAccountAccess,
  listNotebookApiKeys,
  NOTEBOOK_RESOURCE_TYPE,
  NOTEBOOKS_APP_ID,
  type NotebookApiKey,
} from "./access";
import { type ApiKeyPermission, isApiKeyPermission, maxApiKeyPermission } from "./api-key-permissions";

const loadOrCreateNotebookServiceAccount = async (config: {
  notebookId: string;
  notebookName: string;
  actorId: string;
}): Promise<Result<{ serviceAccount: ServiceAccount; created: boolean }>> => {
  const existing = await serviceAccounts.getByResource({
    appId: NOTEBOOKS_APP_ID,
    resourceType: NOTEBOOK_RESOURCE_TYPE,
    resourceId: config.notebookId,
  });
  if (existing) return ok({ serviceAccount: existing, created: false });

  const created = await serviceAccounts.createResourceBound({
    name: `${config.notebookName} API keys`,
    appId: NOTEBOOKS_APP_ID,
    resourceType: NOTEBOOK_RESOURCE_TYPE,
    resourceId: config.notebookId,
    createdBy: config.actorId,
  });
  if (created.ok) return ok({ serviceAccount: created.data, created: true });

  if (created.error.code !== "CONFLICT") return created;

  const raced = await serviceAccounts.getByResource({
    appId: NOTEBOOKS_APP_ID,
    resourceType: NOTEBOOK_RESOURCE_TYPE,
    resourceId: config.notebookId,
  });
  return raced ? ok({ serviceAccount: raced, created: false }) : fail(err.internal("Failed to load resource service account"));
};

export const list = (config: { notebookId: string }): Promise<NotebookApiKey[]> => listNotebookApiKeys(config.notebookId);

export const create = async (config: {
  notebookId: string;
  notebookName: string;
  actor: User;
  data: {
    name: string;
    expiresAt?: string | null;
    permission: ApiKeyPermission;
  };
}): Promise<Result<{ credential: NotebookApiKey; token: string }>> => {
  const serviceAccount = await loadOrCreateNotebookServiceAccount({
    notebookId: config.notebookId,
    notebookName: config.notebookName,
    actorId: config.actor.id,
  });
  if (!serviceAccount.ok) return serviceAccount;

  const cleanupServiceAccount = async () => {
    if (serviceAccount.data.created) {
      await serviceAccounts.delete({ id: serviceAccount.data.serviceAccount.id });
    }
  };

  const existingKeys = await list({ notebookId: config.notebookId });
  const existingPermissions = existingKeys.map((key) => key.permission).filter(isApiKeyPermission);
  const accessPermission = maxApiKeyPermission([...existingPermissions, config.data.permission]);
  const access = await ensureNotebookServiceAccountAccess({
    notebookId: config.notebookId,
    serviceAccountId: serviceAccount.data.serviceAccount.id,
    permission: accessPermission,
  });
  if (!access.ok) {
    await cleanupServiceAccount();
    return access;
  }

  const created = await serviceAccountCredentials.createResourceApiToken({
    serviceAccountId: serviceAccount.data.serviceAccount.id,
    actor: config.actor,
    name: config.data.name,
    expiresAt: config.data.expiresAt ?? null,
    scopes: [config.data.permission],
  });
  if (!created.ok) {
    await cleanupServiceAccount();
    return created;
  }

  return ok({
    credential: {
      ...created.data.credential,
      permission: config.data.permission,
    },
    token: created.data.token,
  });
};

export const revoke = async (config: { notebookId: string; credentialId: string; actor: User }): Promise<Result<{ message: string }>> => {
  const keys = await list({ notebookId: config.notebookId });
  if (!keys.some((key) => key.id === config.credentialId)) return fail(err.notFound("API key"));

  const revoked = await serviceAccountCredentials.revoke({
    credentialId: config.credentialId,
    actor: config.actor,
  });
  if (!revoked.ok) return revoked;

  return ok({ message: "API key revoked." });
};
