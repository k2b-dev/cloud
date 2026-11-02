import { isDeepStrictEqual } from "node:util";
import type { SQL } from "bun";
import { waitWithin } from "../api/fanout";
import type { AppMeta } from "../contracts/app";
import { type AppAccessDeclaration, type AppAccessRule, AppAccessRuleSchema, type ResourceAppAccessAdapter } from "../contracts/app-access";
import type { AppRegistryEntry } from "../contracts/registry";
import { sql } from "../runtime/clients";
import type { RequestAuthority } from "../server/middleware/auth";
import { coreOrigin } from "../services/identity/core-origin";
import { invocationAuthorityFromRequest } from "../services/identity/invocation-authority";
import { type InvocationAuthority, signAppAccessProbe } from "../services/identity/invocation-token";
import { logger } from "../services/logging";
import { appAccessCredential, appAccessRequest } from "./app-access-request";
import { getProcessApplicationId } from "./process-identity";
import { getApp } from "./registry";

export const RESOURCE_ACCESS_PATH = "/api/_internal/app-access/v1";
// Leave six seconds of the ten-second request idle window for authentication,
// grants SQL and rendering. Each queued app gets a fresh one-second probe; no retries.
export const RESOURCE_ACCESS_TIMEOUT_MS = 4_000;
export const RESOURCE_ACCESS_PROBE_TIMEOUT_MS = 1_000;
// Entry and subsequent discovery must together finish before the ten-second idle timeout.
export const RESOURCE_ACCESS_ENTRY_TIMEOUT_MS = 8_000;
// Core's relay and resource resolver read the same live registry row in one
// request. Share that read only within the request, never across requests.
const requestApps = new WeakMap<Request, Map<string, Promise<AppRegistryEntry | null>>>();
export const resourceAccessApp = (appId: string, request?: Request): Promise<AppRegistryEntry | null> => {
  if (!request) return getApp(appId);
  const apps = requestApps.get(request) ?? new Map<string, Promise<AppRegistryEntry | null>>();
  requestApps.set(request, apps);
  const previous = apps.get(appId);
  if (previous) return previous;
  const pending = getApp(appId);
  apps.set(appId, pending);
  return pending;
};
const requestDeadlines = new WeakMap<Request, AbortSignal>();

/** Only browser entry and SSR share a page deadline; long-running API handlers keep fresh check budgets. */
export const startPageResourceAccess = (authority: RequestAuthority | null): void => {
  const request = authority && appAccessRequest(authority);
  if (request && !requestDeadlines.has(request)) requestDeadlines.set(request, AbortSignal.timeout(RESOURCE_ACCESS_ENTRY_TIMEOUT_MS));
};

export const resourceAccessSignal = (authority: RequestAuthority, budget: number, caller?: AbortSignal): AbortSignal => {
  const request = appAccessRequest(authority);
  const requestDeadline = request && requestDeadlines.get(request);
  return AbortSignal.any([
    caller ?? AbortSignal.timeout(budget),
    ...(requestDeadline ? [requestDeadline] : []),
    ...(request ? [request.signal] : []),
  ]);
};
// One summary per app/hop/minute; counters include suppressed slow probes.
const slowProbes = new Map<string, { at: number; count: number }>();
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
  if (previous) return options.signal ? waitWithin(previous, options.signal) : previous;
  const deadline = options.signal ?? resourceAccessSignal(authority, RESOURCE_ACCESS_ENTRY_TIMEOUT_MS);
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
  const started = performance.now();
  const timings: Record<string, number> = {};
  let phase = "adapter";
  let phaseStarted = started;
  const nextPhase = (next: string) => {
    const now = performance.now();
    timings[phase] = Math.round((timings[phase] ?? 0) + now - phaseStarted);
    phase = next;
    phaseStarted = now;
  };
  const hop = localAdapters.has(appId) ? "owner" : getProcessApplicationId() === "core" ? "core-owner" : "app-core";
  let outcome = "denied";
  let reported = false;
  const report = () => {
    if (reported) return;
    reported = true;
    signal.removeEventListener("abort", report);
    const elapsedMs = Math.round(performance.now() - started);
    if (elapsedMs < RESOURCE_ACCESS_PROBE_TIMEOUT_MS / 4) return;
    nextPhase("done");
    const key = `${hop}:${appId}`;
    const previous = slowProbes.get(key);
    const count = (previous?.count ?? 0) + 1;
    if (previous && Date.now() - previous.at < 60_000) {
      previous.count = count;
      return;
    }
    slowProbes.set(key, { at: Date.now(), count: 0 });
    logger("app-access-probe").warn("Slow application access probe", {
      appId,
      hop,
      elapsedMs,
      timings,
      outcome: signal.aborted ? "aborted" : outcome,
      slowProbeCount: count,
    });
  };
  signal.addEventListener("abort", report, { once: true });
  try {
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
        if ((await adapter.hasAnyRight(authority.accessSubject, { authority, db, signal })) === true) {
          outcome = "allowed";
          return true;
        }
      }
      return false;
    }
    if (getProcessApplicationId() === "core") {
      nextPhase("registry");
      const target = await resourceAccessApp(appId, appAccessRequest(authority));
      if (!target || target.access?.kind !== "resources" || !isDeepStrictEqual(target.access, rule)) return false;
      signal.throwIfAborted();
      nextPhase("signing");
      const token = await signAppAccessProbe({
        appId,
        authority: probeAuthority(authority),
      });
      signal.throwIfAborted();
      nextPhase("http");
      const response = await fetch(new URL(`${RESOURCE_ACCESS_PATH}/check`, target.baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal,
        redirect: "error",
      });
      nextPhase("body");
      await response.body?.cancel();
      if (response.status !== 204 && response.status !== 403) throw new Error("Resource app-access probe unavailable");
      outcome = response.status === 204 ? "allowed" : "denied";
      return response.status === 204;
    }
    // Invocations and probe tokens cannot be exchanged for further probes.
    if (authority.credentialKind === "invocation") return false;
    const credential = appAccessCredential(authority);
    if (!credential) return false;
    // Forward exactly the credential admitted on the source route, never a second cookie.
    // Reusable credentials go only to Core; the owner receives only a dedicated probe.
    nextPhase("coreOrigin");
    const origin = await coreOrigin(true);
    nextPhase("http");
    const response = await fetch(new URL(`${RESOURCE_ACCESS_PATH}/apps/${encodeURIComponent(appId)}`, origin), {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
      signal,
      redirect: "error",
    });
    nextPhase("body");
    await response.body?.cancel();
    if (response.status !== 204 && response.status !== 403) throw new Error("Core app-access probe unavailable");
    outcome = response.status === 204 ? "allowed" : "denied";
    return response.status === 204;
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    report();
  }
};
