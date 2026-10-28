import { isDeepStrictEqual } from "node:util";
import { type SQL, sql } from "bun";
import { waitWithin } from "../api/fanout";
import type { AppMeta } from "../contracts/app";
import { type AppAccessDeclaration, type AppAccessRule, AppAccessRuleSchema, type ResourceAppAccessAdapter } from "../contracts/app-access";
import type { RequestAuthority } from "../server/middleware/auth";
import { coreOrigin } from "../services/identity/core-origin";
import { invocationAuthorityFromRequest } from "../services/identity/invocation-authority";
import { type InvocationAuthority, signAppAccessProbe } from "../services/identity/invocation-token";
import { appAccessCredential, appAccessRequest } from "./app-access-request";
import { getProcessApplicationId } from "./process-identity";
import { getApp } from "./registry";

export const RESOURCE_ACCESS_PATH = "/api/_internal/app-access/v1";
// Same budget as the app-entry live revalidation deadline. No retries.
export const RESOURCE_ACCESS_TIMEOUT_MS = 10_000;
const localAdapters = new Map<string, Readonly<Record<string, ResourceAppAccessAdapter>>>();
const requestDecisions = new WeakMap<Request, Map<string, Promise<boolean>>>();
type ResourceRule = Extract<AppAccessRule, { kind: "resources" }>;

/** Called only for the running application, never populated from registry data. */
export const bindResourceAppAccess = (appId: string, declaration?: AppAccessDeclaration): (() => void) => {
  if (declaration?.kind !== "resources" || Array.isArray(declaration.adapters)) return () => {};
  const adapters = declaration.adapters;
  localAdapters.set(appId, adapters);
  return () => {
    if (localAdapters.get(appId) === adapters) localAdapters.delete(appId);
  };
};

// This probe authorizes only a boolean existence check, never an app operation.
// Retain the original credential ceilings and mandate provenance when Core probes.
export const probeAuthority = (authority: RequestAuthority): InvocationAuthority => {
  if (authority.credentialKind !== "invocation") return invocationAuthorityFromRequest(authority);
  const provenance = authority.actor.delegation;
  if (!provenance) throw new Error("Missing invocation provenance");
  const actor = authority.actor;
  const subject = authority.accessSubject;
  return {
    sub: actor.kind === "user" ? actor.user.id : actor.serviceAccount.id,
    principal_type: actor.kind,
    access_subject_type: subject.type,
    access_subject_id: subject.type === "user" ? subject.userId : subject.serviceAccountId,
    ...(actor.kind === "service_account" && actor.delegatedUser ? { delegated_user_id: actor.delegatedUser.id } : {}),
    credential_kind: provenance.credentialKind,
    ...(actor.kind === "user" && actor.sessionKind === "app" ? { session_kind: "app" as const } : {}),
    ...(actor.kind === "service_account" && actor.credentialId ? { credential_id: actor.credentialId } : {}),
    scopes: authority.scopes,
    ...(provenance.mandateId
      ? {
          mandate_id: provenance.mandateId,
          mandate_revision: provenance.mandateRevision,
          workload_type: provenance.workloadType,
          workload_id: provenance.workloadId,
        }
      : {}),
  };
};

export const hasLocalResourceAppAccess = (appId: string): boolean => localAdapters.has(appId);

export const resourceAppAccess = async (
  authority: RequestAuthority,
  app: Pick<AppMeta, "id" | "access">,
  options: { db?: SQL; signal?: AbortSignal } = {},
): Promise<boolean> => {
  const parsed = AppAccessRuleSchema.safeParse(app.access);
  if (!parsed.success || parsed.data.kind !== "resources") return false;
  const rule = parsed.data;
  const request = appAccessRequest(authority);
  // A transaction can see uncommitted rights. Never reuse a request's earlier decision inside it.
  const cache = request && !options.db ? (requestDecisions.get(request) ?? new Map<string, Promise<boolean>>()) : undefined;
  if (request && cache) requestDecisions.set(request, cache);
  const key = JSON.stringify([app.id, rule, authority]);
  const previous = cache?.get(key);
  if (previous) return previous;
  const deadline = options.signal ?? AbortSignal.timeout(RESOURCE_ACCESS_TIMEOUT_MS);
  const signal = request ? AbortSignal.any([deadline, request.signal]) : deadline;
  signal.throwIfAborted();
  const pending = waitWithin(resolveResourceAccess(authority, app.id, rule, options.db ?? sql, signal), signal);
  cache?.set(key, pending);
  return pending;
};

const resolveResourceAccess = async (
  authority: RequestAuthority,
  appId: string,
  rule: ResourceRule,
  db: SQL,
  signal: AbortSignal,
): Promise<boolean> => {
  const adapters = localAdapters.get(appId);
  if (adapters) {
    const bound =
      authority.actor.kind === "service_account" && authority.actor.serviceAccount.kind === "resource_bound"
        ? authority.actor.serviceAccount
        : null;
    for (const name of rule.adapters) {
      if (bound && bound.resourceType !== name) continue;
      signal.throwIfAborted();
      const adapter = adapters[name];
      if (!adapter) throw new Error("Resource adapter declaration changed");
      if ((await adapter.hasAnyRight(authority.accessSubject, { authority, db, signal })) === true) return true;
    }
    return false;
  }
  if (getProcessApplicationId() === "core") {
    const target = await getApp(appId);
    if (!target || target.access?.kind !== "resources" || !isDeepStrictEqual(target.access, rule)) return false;
    signal.throwIfAborted();
    const token = await signAppAccessProbe({
      appId,
      authority: probeAuthority(authority),
    });
    signal.throwIfAborted();
    const response = await fetch(new URL(`${RESOURCE_ACCESS_PATH}/check`, target.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal,
      redirect: "error",
    });
    await response.body?.cancel();
    if (response.status !== 204 && response.status !== 403) throw new Error("Resource app-access probe unavailable");
    return response.status === 204;
  }
  // Invocations and probe tokens cannot be exchanged for further probes.
  if (authority.credentialKind === "invocation") return false;
  const credential = appAccessCredential(authority);
  if (!credential) return false;
  // Forward exactly the credential admitted on the source route, never a second cookie.
  // Reusable credentials go only to Core; the owner receives only a dedicated probe.
  const response = await fetch(new URL(`${RESOURCE_ACCESS_PATH}/apps/${encodeURIComponent(appId)}`, await coreOrigin(true)), {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
    signal,
    redirect: "error",
  });
  await response.body?.cancel();
  if (response.status !== 204 && response.status !== 403) throw new Error("Core app-access probe unavailable");
  return response.status === 204;
};
