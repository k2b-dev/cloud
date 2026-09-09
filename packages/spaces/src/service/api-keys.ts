import { type ServiceAccount, serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { PermissionLevel, User } from "@/contracts";
import { ensureSpaceServiceAccountAccess, listSpaceApiKeys, SPACE_RESOURCE_TYPE, SPACES_APP_ID, type SpaceApiKey } from "./access";

const API_KEY_PERMISSION_RANK: Record<Extract<PermissionLevel, "none" | "read" | "write" | "admin">, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

type ApiKeyPermission = Extract<PermissionLevel, "read" | "write" | "admin">;

const isApiKeyPermission = (permission: PermissionLevel): permission is ApiKeyPermission => permission !== "none";

const maxPermission = (permissions: ApiKeyPermission[]): ApiKeyPermission => {
  let max: ApiKeyPermission = "read";
  for (const permission of permissions) {
    if (API_KEY_PERMISSION_RANK[permission] > API_KEY_PERMISSION_RANK[max]) {
      max = permission;
    }
  }
  return max;
};

const loadOrCreateSpaceServiceAccount = async (config: {
  spaceId: string;
  spaceName: string;
  actorId: string;
}): Promise<Result<{ serviceAccount: ServiceAccount; created: boolean }>> => {
  const existing = await serviceAccounts.getByResource({
    appId: SPACES_APP_ID,
    resourceType: SPACE_RESOURCE_TYPE,
    resourceId: config.spaceId,
  });
  if (existing) return ok({ serviceAccount: existing, created: false });

  const created = await serviceAccounts.createResourceBound({
    name: `${config.spaceName} API keys`,
    appId: SPACES_APP_ID,
    resourceType: SPACE_RESOURCE_TYPE,
    resourceId: config.spaceId,
    createdBy: config.actorId,
  });
  if (created.ok) return ok({ serviceAccount: created.data, created: true });

  if (created.error.code !== "CONFLICT") return created;

  const raced = await serviceAccounts.getByResource({
    appId: SPACES_APP_ID,
    resourceType: SPACE_RESOURCE_TYPE,
    resourceId: config.spaceId,
  });
  return raced ? ok({ serviceAccount: raced, created: false }) : fail(err.internal("Failed to load resource service account"));
};

export const list = (config: { spaceId: string }): Promise<SpaceApiKey[]> => listSpaceApiKeys(config.spaceId);

export const create = async (config: {
  spaceId: string;
  spaceName: string;
  actor: User;
  data: {
    name: string;
    expiresAt?: string | null;
    permission: Extract<PermissionLevel, "read" | "write" | "admin">;
  };
}): Promise<Result<{ credential: SpaceApiKey; token: string }>> => {
  const serviceAccount = await loadOrCreateSpaceServiceAccount({
    spaceId: config.spaceId,
    spaceName: config.spaceName,
    actorId: config.actor.id,
  });
  if (!serviceAccount.ok) return serviceAccount;

  const cleanupServiceAccount = async () => {
    if (serviceAccount.data.created) {
      await serviceAccounts.delete({ id: serviceAccount.data.serviceAccount.id });
    }
  };

  const existingKeys = await list({ spaceId: config.spaceId });
  const existingPermissions = existingKeys.map((key) => key.permission).filter(isApiKeyPermission);
  const accessPermission = maxPermission([...existingPermissions, config.data.permission]);
  const access = await ensureSpaceServiceAccountAccess({
    spaceId: config.spaceId,
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

export const revoke = async (config: { spaceId: string; credentialId: string; actor: User }): Promise<Result<{ message: string }>> => {
  const keys = await list({ spaceId: config.spaceId });
  if (!keys.some((key) => key.id === config.credentialId)) return fail(err.notFound("API key"));

  const revoked = await serviceAccountCredentials.revoke({
    credentialId: config.credentialId,
    actor: config.actor,
  });
  if (!revoked.ok) return revoked;

  return ok({ message: "API key revoked." });
};
