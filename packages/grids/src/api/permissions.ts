import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { AccessSubject, AuthContext, PermissionLevel, RequestActor } from "@k2b/cloud/server";
import type { Context } from "hono";
import type { Grant } from "../service";
import { gridsService } from "../service";
import type { SqlClient } from "../service/audit";
import { hasAtLeast, minPermission, permissionFromCredentialScopes } from "../service/permission-resolver";
import { workflowCredentialBinding } from "../service/workflow-authorization";
import type { GridsWorkflowPrincipal } from "../workflows/contracts";

export type GridsAccessContext = {
  actor: RequestActor | undefined;
  accessSubject: AccessSubject | null;
};

export const gridsAccessContext = <T extends AuthContext>(c: Context<T>): GridsAccessContext => ({
  actor: c.get("actor") as AuthContext["Variables"]["actor"] | undefined,
  accessSubject: (c.get("accessSubject") as AuthContext["Variables"]["accessSubject"] | undefined) ?? null,
});

const actorUser = (access: GridsAccessContext) => {
  const actor = access.actor;
  if (!actor) return null;
  return actor.kind === "user" ? actor.user : actor.delegatedUser;
};

export const accessActorUser = (access: GridsAccessContext) => actorUser(access);
export const currentActorUser = <T extends AuthContext>(c: Context<T>) => actorUser(gridsAccessContext(c));
export const currentActorUserId = <T extends AuthContext>(c: Context<T>) => currentActorUser(c)?.id ?? null;

const accessSubjectFor = (access: GridsAccessContext): AccessSubject | null => {
  if (access.accessSubject) return access.accessSubject;
  const user = actorUser(access);
  return user ? { type: "user", userId: user.id } : null;
};

export const currentAccessSubject = <T extends AuthContext>(c: Context<T>): AccessSubject | null => accessSubjectFor(gridsAccessContext(c));

/** `undefined` means unbound; `null` means a binding invalid for raw Grids. */
export const resourceBoundBaseIdFor = (access: GridsAccessContext): string | null | undefined => {
  const actor = access.actor;
  if (actor?.kind !== "service_account" || actor.serviceAccount.kind !== "resource_bound") return undefined;
  const account = actor.serviceAccount;
  return account.appId === "grids" && account.resourceType === "base" ? account.resourceId : null;
};

export const currentResourceBoundBaseId = <T extends AuthContext>(c: Context<T>): string | null | undefined =>
  resourceBoundBaseIdFor(gridsAccessContext(c));

const credentialPermissionFor = (access: GridsAccessContext): PermissionLevel =>
  access.actor?.kind === "service_account" ? permissionFromCredentialScopes(access.actor.scopes) : "admin";

export const currentCredentialPermission = <T extends AuthContext>(c: Context<T>): PermissionLevel =>
  credentialPermissionFor(gridsAccessContext(c));

export const gateCredentialScopeFor = async (
  access: GridsAccessContext,
  required: PermissionLevel,
  options: { allowResourceBound?: boolean } = {},
): Promise<Result<PermissionLevel>> => {
  const level = credentialPermissionFor(access);
  if (!hasAtLeast(level, required)) {
    return fail(err.forbidden("The API credential does not grant the required Grids scope."));
  }
  if (options.allowResourceBound === false && resourceBoundBaseIdFor(access) !== undefined) {
    return fail(err.forbidden("Resource-bound API credentials cannot create Grids bases."));
  }
  return ok(level);
};

export const gateCredentialScope = <T extends AuthContext>(
  c: Context<T>,
  required: PermissionLevel,
  options: { allowResourceBound?: boolean } = {},
) => gateCredentialScopeFor(gridsAccessContext(c), required, options);

export const actorViewerFor = (access: GridsAccessContext) => {
  const subject = accessSubjectFor(access);
  const user = actorUser(access);
  return {
    userId: subject?.type === "user" ? subject.userId : null,
    userGroups: user?.memberofGroupIds ?? [],
    serviceAccountId: subject?.type === "service_account" ? subject.serviceAccountId : null,
  };
};

export const currentActorViewer = <T extends AuthContext>(c: Context<T>) => actorViewerFor(gridsAccessContext(c));

export const workflowPrincipalFor = (access: GridsAccessContext): GridsWorkflowPrincipal => {
  const actor = access.actor;
  const viewer = actorViewerFor(access);
  if (!actor || actor.kind === "user") {
    return {
      userId: viewer.userId,
      groupIds: viewer.userGroups,
      serviceAccountId: viewer.serviceAccountId,
      actorServiceAccountId: null,
      credential: null,
    };
  }
  const credentialId = actor.credentialId ?? null;
  return {
    userId: viewer.userId,
    groupIds: viewer.userGroups,
    serviceAccountId: viewer.serviceAccountId,
    actorServiceAccountId: actor.serviceAccount.id,
    credential: {
      kind: credentialId ? "api_token" : "oauth",
      id: credentialId,
      scopes: [...actor.scopes],
      permissionCap: permissionFromCredentialScopes(actor.scopes),
      expiresAt: actor.credentialExpiresAt ?? null,
      resourceBinding: workflowCredentialBinding(actor.serviceAccount),
    },
  };
};

export const currentWorkflowPrincipal = <T extends AuthContext>(c: Context<T>): GridsWorkflowPrincipal =>
  workflowPrincipalFor(gridsAccessContext(c));

const deny = () => fail(err.forbidden("You do not have permission to access this resource."));

export const gateBaseAtAccess = async (
  access: GridsAccessContext,
  baseId: string,
  required: PermissionLevel,
  client?: SqlClient,
): Promise<Result<PermissionLevel>> => {
  const boundBaseId = resourceBoundBaseIdFor(access);
  if (boundBaseId !== undefined && boundBaseId !== baseId) return deny();
  const credentialLevel = credentialPermissionFor(access);
  if (!gridsService.permission.hasAtLeast(credentialLevel, required)) return deny();
  const grants = await gridsService.permission.loadBaseGrantsForSubject({ baseId, subject: accessSubjectFor(access) }, client);
  const level = minPermission(gridsService.permission.resolve(grants, { baseId }), credentialLevel);
  return gridsService.permission.hasAtLeast(level, required) ? ok(level) : deny();
};

export const gateAt = (
  c: Context<AuthContext>,
  target: { baseId: string },
  required: PermissionLevel,
  client?: SqlClient,
): Promise<Result<PermissionLevel>> => gateBaseAtAccess(gridsAccessContext(c), target.baseId, required, client);

export const resolveBaseWithGrantsForAccess = async (
  access: GridsAccessContext,
  baseId: string,
): Promise<{ level: PermissionLevel; grants: Grant[] }> => {
  const boundBaseId = resourceBoundBaseIdFor(access);
  if (boundBaseId !== undefined && boundBaseId !== baseId) return { level: "none", grants: [] };
  const grants = await gridsService.permission.loadBaseGrantsForSubject({ baseId, subject: accessSubjectFor(access) });
  return {
    level: minPermission(gridsService.permission.resolve(grants, { baseId }), credentialPermissionFor(access)),
    grants,
  };
};

export const resolveCustomAppWithGrantsForAccess = async (
  access: GridsAccessContext,
  customAppId: string,
): Promise<{ level: PermissionLevel; grants: Grant[] }> => {
  if (resourceBoundBaseIdFor(access) !== undefined) return { level: "none", grants: [] };
  const grants = await gridsService.permission.loadCustomAppGrantsForSubject({ customAppId, subject: accessSubjectFor(access) });
  return {
    level: minPermission(gridsService.permission.resolve(grants, { customAppId }), credentialPermissionFor(access)),
    grants,
  };
};

export const gateCustomAppAtAccess = async (access: GridsAccessContext, customAppId: string): Promise<Result<PermissionLevel>> => {
  const resolved = await resolveCustomAppWithGrantsForAccess(access, customAppId);
  return gridsService.permission.hasAtLeast(resolved.level, "read") ? ok(resolved.level) : deny();
};
