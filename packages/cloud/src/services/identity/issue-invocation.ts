import type { SQL } from "bun";
import { getApp } from "../../_internal/registry";
import type { AppMeta } from "../../contracts/app";
import { AppAccessDeniedError } from "../../server/middleware/app-access";
import type { RequestAuthority } from "../../server/middleware/auth";
import { canUseApp } from "../app-access";
import { recordAppAccessDenied } from "../app-access-metrics";
import { CLOUD_INVOCATION_TOKEN_TTL_SECONDS } from "./constants";
import { resolveInvocationAuthority } from "./invocation-actor";
import { matchesInvocationSubject } from "./invocation-authority";
import { type InvocationAuthority, signInvocationToken } from "./invocation-token";
import { readIdentityGroupsAdmin } from "./runtime-config";

/** Reload the principal while retaining the original credential's scopes and mobile-session restriction. */
export const resolveIssuanceAuthority = async (
  authority: InvocationAuthority,
  callingAppId: string,
  query?: Parameters<typeof resolveInvocationAuthority>[1],
  groupsAdmin?: readonly string[],
): Promise<RequestAuthority | null> => {
  const preparedGroups = groupsAdmin ?? (query ? await readIdentityGroupsAdmin(query) : undefined);
  return resolveInvocationAuthority(
    {
      ...authority,
      act: { sub: `app:${callingAppId}` },
      jti: crypto.randomUUID(),
      exp: Math.floor(Date.now() / 1_000) + CLOUD_INVOCATION_TOKEN_TTL_SECONDS,
    },
    query,
    preparedGroups ? [...preparedGroups] : undefined,
  );
};

type RegisteredAppAccessOptions = {
  db?: SQL;
  getApp?: (id: string) => Promise<Pick<AppMeta, "id" | "access"> | null>;
};

export const requireRegisteredAppAccess = async (
  authority: RequestAuthority | null,
  appId: string,
  options: RegisteredAppAccessOptions = {},
): Promise<void> => {
  const app = await (options.getApp ?? getApp)(appId).catch(() => null);
  if (!app || !authority || !(await canUseApp(authority, app, { db: options.db }))) {
    if (app) recordAppAccessDenied(app.id);
    throw new AppAccessDeniedError(app ?? { id: appId });
  }
};

/** The production broker seam for capability, widget, search, stream, and inter-app issuance. */
export const issueInvocationToken = async (
  params: Parameters<typeof signInvocationToken>[0],
  dependencies: RegisteredAppAccessOptions & {
    groupsAdmin?: readonly string[];
    resolve?: typeof resolveIssuanceAuthority;
    sign?: typeof signInvocationToken;
  } = {},
): ReturnType<typeof signInvocationToken> => {
  const authority = await (dependencies.resolve ?? resolveIssuanceAuthority)(
    params.authority,
    params.callingAppId,
    dependencies.db,
    dependencies.groupsAdmin,
  );
  if (params.parent && (!authority || !matchesInvocationSubject(params.parent, authority)))
    throw new AppAccessDeniedError({ id: params.targetAppId });
  await requireRegisteredAppAccess(authority, params.targetAppId, dependencies);
  return (dependencies.sign ?? signInvocationToken)(params);
};
