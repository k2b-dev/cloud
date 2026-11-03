import type { SQL } from "bun";
import { getApp, listApps } from "../../_internal/registry";
import type { AppMeta } from "../../contracts/app";
import { AppAccessDeniedError } from "../../server/middleware/app-access";
import type { RequestAuthority } from "../../server/middleware/auth";
import { canUseApp, usableAppIds } from "../app-access";
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
  signal?: AbortSignal;
  getApp?: (id: string) => Promise<Pick<AppMeta, "id" | "access"> | null>;
};

export const requireRegisteredAppAccess = async (
  authority: RequestAuthority | null,
  appId: string,
  options: RegisteredAppAccessOptions = {},
): Promise<void> => {
  options.signal?.throwIfAborted();
  const app = await (options.getApp ?? getApp)(appId).catch(() => null);
  if (!app || !authority || !(await canUseApp(authority, app, { db: options.db, signal: options.signal }))) {
    options.signal?.throwIfAborted();
    if (app) recordAppAccessDenied(app.id);
    throw new AppAccessDeniedError(app ?? { id: appId });
  }
};

/**
 * Prepares issuance for many targets of one request: the principal is reloaded once and app access is decided for
 * all targets in one batch with that reloaded authority, so the cost does not grow with the number of targets.
 * Run it under the caller's signer guard; only targets that discovery already admitted can be signed.
 */
export const prepareFanoutIssuance = async (
  params: Pick<Parameters<typeof signInvocationToken>[0], "authority" | "callingAppId"> & {
    /** The discovery-admitted entries of this request. */
    entries: readonly { appId: string }[];
  },
  dependencies: {
    db?: SQL;
    signal?: AbortSignal;
    groupsAdmin?: readonly string[];
    registry?: () => Promise<readonly Pick<AppMeta, "id" | "access">[]>;
    resolve?: typeof resolveIssuanceAuthority;
    sign?: typeof signInvocationToken;
  } = {},
) => {
  dependencies.signal?.throwIfAborted();
  const authority = await (dependencies.resolve ?? resolveIssuanceAuthority)(
    params.authority,
    params.callingAppId,
    dependencies.db,
    dependencies.groupsAdmin,
  );
  const ids = new Set(params.entries.map((entry) => entry.appId));
  const apps = ids.size ? (await (dependencies.registry ?? listApps)()).filter((app) => ids.has(app.id)) : [];
  // The reloaded authority decides, as for a single issuance: a phone's session, for example, has no admin role here.
  const usable =
    authority && apps.length ? await usableAppIds(authority, apps, { db: dependencies.db, signal: dependencies.signal }) : null;
  return async (target: Omit<Parameters<typeof signInvocationToken>[0], "authority" | "callingAppId">) => {
    dependencies.signal?.throwIfAborted();
    if (target.parent && (!authority || !matchesInvocationSubject(target.parent, authority)))
      throw new AppAccessDeniedError({ id: target.targetAppId });
    if (!usable?.has(target.targetAppId)) {
      if (apps.some((app) => app.id === target.targetAppId)) recordAppAccessDenied(target.targetAppId);
      throw new AppAccessDeniedError({ id: target.targetAppId });
    }
    return (dependencies.sign ?? signInvocationToken)({ ...target, authority: params.authority, callingAppId: params.callingAppId });
  };
};

/** The production broker seam for single-target capability, widget, stream, and inter-app issuance. */
export const issueInvocationToken = async (
  params: Parameters<typeof signInvocationToken>[0],
  dependencies: RegisteredAppAccessOptions & {
    groupsAdmin?: readonly string[];
    resolve?: typeof resolveIssuanceAuthority;
    sign?: typeof signInvocationToken;
  } = {},
): ReturnType<typeof signInvocationToken> => {
  dependencies.signal?.throwIfAborted();
  const authority = await (dependencies.resolve ?? resolveIssuanceAuthority)(
    params.authority,
    params.callingAppId,
    dependencies.db,
    dependencies.groupsAdmin,
  );
  if (params.parent && (!authority || !matchesInvocationSubject(params.parent, authority)))
    throw new AppAccessDeniedError({ id: params.targetAppId });
  await requireRegisteredAppAccess(authority, params.targetAppId, dependencies);
  dependencies.signal?.throwIfAborted();
  return (dependencies.sign ?? signInvocationToken)(params);
};
