import type { User } from "@valentinkolb/cloud/contracts";
import {
  type AccessEntry,
  type AccessSubject,
  type AuthContext,
  auth,
  err,
  fail,
  getEffectivePermission,
  hasPermission,
  ok,
  type PermissionLevel,
  type RequestActor,
  type ResourceAccessAdapter,
  type Result,
} from "@valentinkolb/cloud/server";
import { type ServiceAccountCredential, serviceAccountCredentials, serviceAccounts } from "@valentinkolb/cloud/services";
import { Hono } from "hono";

type AccessRepository = {
  list(itemId: string): Promise<AccessEntry[]>;
  link(itemId: string, accessId: string): Promise<Result<void>>;
  unlink(itemId: string, accessId: string): Promise<Result<void>>;
  count(itemId: string): Promise<number>;
};

export const createItemAccessAdapter = (repository: AccessRepository): ResourceAccessAdapter => ({
  list: repository.list,
  add: repository.link,
  remove: repository.unlink,
  count: repository.count,
});

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

const permissionFromScopes = (scopes: readonly string[]): PermissionLevel => {
  if (scopes.includes("admin")) return "admin";
  if (scopes.includes("write")) return "write";
  if (scopes.includes("read")) return "read";
  return "none";
};

const lowerPermission = (permission: PermissionLevel, cap: PermissionLevel): PermissionLevel =>
  PERMISSION_RANK[permission] <= PERMISSION_RANK[cap] ? permission : cap;

// Call this from the application's serialized resource lifecycle.
export const provisionItemServiceAccount = async (input: {
  itemId: string;
  itemName: string;
  actor: User;
  ensureServiceAccountAccess(serviceAccountId: string, permission: PermissionLevel): Promise<Result<void>>;
}) => {
  const existing = await serviceAccounts.getByResource({
    appId: "inventory",
    resourceType: "item",
    resourceId: input.itemId,
  });
  const serviceAccount = existing
    ? ok(existing)
    : await serviceAccounts.createResourceBound({
        name: `${input.itemName} API access`,
        appId: "inventory",
        resourceType: "item",
        resourceId: input.itemId,
        createdBy: input.actor.id,
      });
  if (!serviceAccount.ok) return serviceAccount;

  const access = await input.ensureServiceAccountAccess(serviceAccount.data.id, "admin");
  if (!access.ok) return access;

  return serviceAccount;
};

export const requireItemPermission = async (input: {
  itemId: string;
  required: PermissionLevel;
  actor: RequestActor;
  accessSubject: AccessSubject;
  access: Pick<ResourceAccessAdapter, "list">;
}): Promise<Result<PermissionLevel>> => {
  const resourceCredential = input.actor.kind === "service_account" && input.actor.delegatedUser === null ? input.actor : null;

  if (
    resourceCredential &&
    (resourceCredential.serviceAccount.kind !== "resource_bound" ||
      resourceCredential.serviceAccount.appId !== "inventory" ||
      resourceCredential.serviceAccount.resourceType !== "item" ||
      resourceCredential.serviceAccount.resourceId !== input.itemId)
  ) {
    return fail(err.forbidden("Access denied"));
  }

  const entries = await input.access.list(input.itemId);
  const granted = await getEffectivePermission({
    accessIds: entries.map((entry) => entry.id),
    subject: input.accessSubject,
  });
  const effective = resourceCredential ? lowerPermission(granted, permissionFromScopes(resourceCredential.scopes)) : granted;

  return hasPermission(effective, input.required) ? ok(effective) : fail(err.forbidden("Access denied"));
};

export const createItemApiKey = async (input: {
  itemId: string;
  serviceAccountId: string;
  actor: User;
  name: string;
  permission: Exclude<PermissionLevel, "none">;
  expiresAt?: string | null;
}) => {
  const serviceAccount = await serviceAccounts.get({
    id: input.serviceAccountId,
  });
  if (
    !serviceAccount ||
    serviceAccount.status !== "active" ||
    serviceAccount.kind !== "resource_bound" ||
    serviceAccount.appId !== "inventory" ||
    serviceAccount.resourceType !== "item" ||
    serviceAccount.resourceId !== input.itemId
  ) {
    return fail(err.notFound("Resource service account"));
  }

  return serviceAccountCredentials.createResourceApiToken({
    serviceAccountId: serviceAccount.id,
    actor: input.actor,
    name: input.name,
    expiresAt: input.expiresAt ?? null,
    scopes: [input.permission],
  });
};

export const listItemApiKeys = async (itemId: string): Promise<Array<ServiceAccountCredential & { permission: PermissionLevel }>> => {
  const page = await serviceAccountCredentials.listOverview({
    pagination: { page: 1, perPage: 500 },
    filter: {
      serviceAccountKind: "resource_bound",
      credentialStatus: "active",
      appId: "inventory",
      resourceType: "item",
      resourceId: itemId,
    },
  });

  return page.items.map(({ serviceAccount: _account, owner: _owner, ...key }) => ({
    ...key,
    permission: permissionFromScopes(key.scopes),
  }));
};

export const revokeItemApiKey = async (input: { itemId: string; credentialId: string; actor: User }): Promise<Result<void>> => {
  const credential = await serviceAccountCredentials.getOverview({
    id: input.credentialId,
  });

  if (
    !credential ||
    credential.serviceAccount.kind !== "resource_bound" ||
    credential.serviceAccount.appId !== "inventory" ||
    credential.serviceAccount.resourceType !== "item" ||
    credential.serviceAccount.resourceId !== input.itemId
  ) {
    return fail(err.notFound("API key"));
  }

  return serviceAccountCredentials.revoke({
    credentialId: input.credentialId,
    actor: input.actor,
  });
};

export const protectedRoutes = new Hono<AuthContext>().use("*", auth.requireRole("authenticated")).get("/:id", (c) =>
  c.json({
    actor: c.get("actor"),
    accessSubject: c.get("accessSubject"),
  }),
);

export const browserRoutes = new Hono<AuthContext>().get(
  "/:id",
  auth.requireRole("authenticated", auth.redirectToLogin),
  auth.requireUser(),
  (c) => c.text(`Signed in as ${c.get("actor").kind}`),
);

export const optionalRoutes = new Hono<AuthContext>().use("*", auth.requireRole("*")).get("/:id", (c) => {
  const actor = c.get("actor");
  const accessSubject = actor ? c.get("accessSubject") : null;
  return c.json({ authenticated: Boolean(actor), accessSubject });
});
