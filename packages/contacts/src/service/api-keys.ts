import type { PermissionLevel, User } from "@k2b/cloud/contracts";
import { serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { CONTACT_BOOK_RESOURCE_TYPE, CONTACTS_APP_ID, type ContactBookApiKey, grantBookAccess, listContactBookApiKeys } from "./access";

export const list = (config: { bookId: string }): Promise<ContactBookApiKey[]> => listContactBookApiKeys(config.bookId);

export const create = async (config: {
  bookId: string;
  bookName: string;
  actor: User;
  data: {
    name: string;
    expiresAt?: string | null;
    permission: Extract<PermissionLevel, "read" | "write" | "admin">;
  };
}): Promise<Result<{ credential: ContactBookApiKey; token: string }>> => {
  const serviceAccount = await serviceAccounts.createResourceBound({
    name: `${config.bookName} API key: ${config.data.name}`,
    appId: CONTACTS_APP_ID,
    resourceType: CONTACT_BOOK_RESOURCE_TYPE,
    resourceId: config.bookId,
    createdBy: config.actor.id,
  });
  if (!serviceAccount.ok) return serviceAccount;

  const cleanupServiceAccount = async () => {
    await serviceAccounts.delete({ id: serviceAccount.data.id });
  };

  const access = await grantBookAccess({
    bookId: config.bookId,
    principal: { type: "service_account", serviceAccountId: serviceAccount.data.id },
    permission: config.data.permission,
  });
  if (!access.ok) {
    await cleanupServiceAccount();
    return access;
  }

  const created = await serviceAccountCredentials.createResourceApiToken({
    serviceAccountId: serviceAccount.data.id,
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
      permission: access.data.permission,
    },
    token: created.data.token,
  });
};

export const revoke = async (config: { bookId: string; credentialId: string; actor: User }): Promise<Result<{ message: string }>> => {
  const keys = await list({ bookId: config.bookId });
  if (!keys.some((key) => key.id === config.credentialId)) return fail(err.notFound("API key"));

  const revoked = await serviceAccountCredentials.revoke({
    credentialId: config.credentialId,
    actor: config.actor,
  });
  if (!revoked.ok) return revoked;

  return ok({ message: "API key revoked." });
};
