import type { CloudCliContext } from "@valentinkolb/cloud/cli";
import { resolveAccessPrincipal } from "@valentinkolb/cloud/cli";
import type { PermissionLevel, Principal } from "@valentinkolb/cloud/contracts";
import { resolveCustomApp } from "./custom-apps";
import { resolveBase, resolveBaseFromCommand } from "./resources";
import { requireRestArg } from "./runtime";

export const PERMISSION_LEVELS = ["none", "read", "write", "admin"] as const satisfies readonly PermissionLevel[];

export const ACCESS_RESOURCE_TYPES = ["base", "app"] as const;

type AccessResourceType = (typeof ACCESS_RESOURCE_TYPES)[number];

export type AccessPermission = (typeof PERMISSION_LEVELS)[number];

type AccessResource = {
  type: AccessResourceType;
  id: string;
  label: string;
  allowed: readonly AccessPermission[];
};

export const accessPermissionsForResource = (type: AccessResourceType): readonly AccessPermission[] => {
  switch (type) {
    case "base":
      return ["read", "write", "admin", "none"];
    case "app":
      return ["read", "none"];
  }
};

export const assertAccessPermission = (resource: AccessResource, permission: AccessPermission) => {
  if (!resource.allowed.includes(permission)) {
    throw new Error(`${resource.type} grants only accept: ${resource.allowed.join(", ")}.`);
  }
};

export const resolveAccessResource = async (ctx: CloudCliContext, args: string[]): Promise<AccessResource> => {
  const type = requireRestArg(args, 0, "resource type") as AccessResourceType;
  if (!(ACCESS_RESOURCE_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Resource type must be one of: ${ACCESS_RESOURCE_TYPES.join(", ")}.`);
  }
  const rest = args.slice(1);
  if (type === "base") {
    const base = await resolveBase(ctx, requireRestArg(rest, 0, "base"));
    return {
      type,
      id: base.id,
      label: `${base.name} (${base.id})`,
      allowed: accessPermissionsForResource(type),
    };
  }
  const { base, rest: appRest } = await resolveBaseFromCommand(ctx, rest, 1);
  const app = await resolveCustomApp(ctx, base.id, requireRestArg(appRest, 0, "App"));
  return { type, id: app.id, label: `${app.name} (${app.id})`, allowed: accessPermissionsForResource(type) };
};

export const accessResourcePath = (resource: AccessResource): string =>
  resource.type === "base"
    ? `/access/by-base/${encodeURIComponent(resource.id)}`
    : `/access/by-custom-app/${encodeURIComponent(resource.id)}`;

export const principalKey = (principal: Principal): string => {
  switch (principal.type) {
    case "user":
      return `user:${principal.userId}`;
    case "group":
      return `group:${principal.groupId}`;
    case "service_account":
      return `service_account:${principal.serviceAccountId}`;
    case "authenticated":
      return "authenticated";
    case "public":
      return "public";
  }
};

export const assertAccessPrincipal = (resource: AccessResource, principal: Principal): void => {
  if (resource.type === "base" && principal.type === "public") {
    throw new Error("Public access is only supported for Grids Apps.");
  }
  if (resource.type === "app" && principal.type === "service_account") {
    throw new Error("Grids App access does not support service accounts; grant access to the delegated user instead.");
  }
};

export const resolvePrincipalForAccess = (ctx: CloudCliContext, flags: Record<string, unknown>): Promise<Principal> =>
  resolveAccessPrincipal(ctx, flags, { allowPublic: true, allowServiceAccounts: true });
