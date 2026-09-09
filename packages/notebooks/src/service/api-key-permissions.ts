import type { PermissionLevel } from "@k2b/cloud/contracts";

export type ApiKeyPermission = Extract<PermissionLevel, "read" | "write" | "admin">;

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

export const isApiKeyPermission = (permission: PermissionLevel): permission is ApiKeyPermission => permission !== "none";

export const maxApiKeyPermission = (permissions: ApiKeyPermission[]): ApiKeyPermission => {
  let max: ApiKeyPermission = "read";
  for (const permission of permissions) {
    if (PERMISSION_RANK[permission] > PERMISSION_RANK[max]) {
      max = permission;
    }
  }
  return max;
};

const permissionFromScopes = (scopes: string[]): PermissionLevel => {
  if (scopes.includes("admin")) return "admin";
  if (scopes.includes("write")) return "write";
  if (scopes.includes("read")) return "read";
  return "none";
};

const minPermission = (a: PermissionLevel, b: PermissionLevel): PermissionLevel => (PERMISSION_RANK[a] <= PERMISSION_RANK[b] ? a : b);

export const resolveNotebookApiKeyPermission = (accessPermission: PermissionLevel, credentialScopes: string[]): PermissionLevel =>
  minPermission(accessPermission, permissionFromScopes(credentialScopes));
