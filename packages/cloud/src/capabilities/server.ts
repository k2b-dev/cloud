import { z } from "zod";
import { resolveCapabilityManifestPresentation } from "../_internal/capabilities";
import { getApp, getCapability } from "../_internal/registry";
import type { RequestAuthority } from "../server";
import { dispatchCapability, loadCapabilityCatalogPage } from "../api/capabilities";
import { type CapabilityOrigin, CAPABILITY_FRAMEWORK_ERROR_CODES, CapabilityActionReviewSchema, capabilityResultSchema } from "../contracts/capabilities";
import { get } from "../services/settings";
import { resolveAppPresentation } from "../shared/app-presentation";
import { publicCloudOrigin } from "../shared/app-url";
import { capabilityMessages } from "../shared/capability-messages";
import { LOCALE_HEADER } from "../shared/locale";
import { readCapabilityResponse } from "./response";
import { combineCapabilitySignals } from "./signals";
import type {
  CapabilityCatalogAppClientResult,
  CapabilityCatalogClientResult,
  CapabilityClientError,
  CapabilityClientResult,
  CapabilityInvocation,
  CapabilityReviewClientResult,
} from "./types";

export type {
  CapabilityCatalogApp,
  CapabilityCatalogAppClientResult,
  CapabilityCatalogClientResult,
  CapabilityClientResult,
  CapabilityInvocation,
  CapabilityReviewClientResult,
} from "./types";

export type CapabilityCaller = {
  /** Server-only authority from verified request middleware; never accept this from a request body or worker. */
  authority?: RequestAuthority;
  origin?: CapabilityOrigin;

  authorization?: string | null;
  cookie?: string | null;
  requestId?: string | null;
  traceparent?: string | null;
  tracestate?: string | null;
  /** BCP 47 locale of the originating request, forwarded as invocation metadata. */
  locale?: string | null;
  signal?: AbortSignal;
  /** Durable background authority. `authorization` must be the owning app's workload credential. */
  mandate?: { id: string; revision: number; callingAppId: string };
};

const coreOrigin = async (internal = false): Promise<string> => {
  const configured = process.env.CLOUD_CORE_INTERNAL_ORIGIN?.trim();
  if (internal && !configured) throw new Error("CLOUD_CORE_INTERNAL_ORIGIN is required for mandate-backed invocation");
  const origin = configured || publicCloudOrigin(await get<string>("app.url"));
  const url = new URL(origin);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("CLOUD_CORE_INTERNAL_ORIGIN must use http or https");
  return url.origin;
};

const callerRequest = async (
  caller: CapabilityCaller,
  path: string,
  idempotencyKey?: string,
  invocationSignal?: AbortSignal,
): Promise<Request> => {
  const headers = new Headers();
  if (caller.authorization) headers.set("authorization", caller.authorization);
  if (!caller.mandate) {
    if (caller.cookie) headers.set("cookie", caller.cookie);
    if (caller.requestId) headers.set("x-request-id", caller.requestId);
    if (caller.traceparent) headers.set("traceparent", caller.traceparent);
    if (caller.tracestate) headers.set("tracestate", caller.tracestate);
    if (caller.locale) headers.set(LOCALE_HEADER, caller.locale);
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  } else {
    headers.set("x-cloud-app-id", caller.mandate.callingAppId);
  }
  const signal = combineCapabilitySignals(caller.signal, invocationSignal);
  return new Request(new URL(path, await coreOrigin(caller.mandate !== undefined)), { method: "POST", headers, signal });
};

const unavailable = (
  cause: unknown,
  invocation?: Pick<CapabilityInvocation, "kind" | "idempotencyKey">,
  locale?: string,
): { ok: false; error: CapabilityClientError } => ({
  ok: false,
  error:
    invocation?.kind === "action" && !invocation.idempotencyKey
      ? {
          code: CAPABILITY_FRAMEWORK_ERROR_CODES.actionOutcomeUnknown,
          message: capabilityMessages(locale).actionOutcomeUnknown,
          status: 502,
          details: { retrySafe: false },
        }
      : cause instanceof Error && cause.name === "AbortError"
        ? {
            code: CAPABILITY_FRAMEWORK_ERROR_CODES.requestCancelled,
            message: capabilityMessages(locale).requestCancelled,
            status: 499,
          }
        : {
            code: CAPABILITY_FRAMEWORK_ERROR_CODES.appUnavailable,
            message: capabilityMessages(locale).cloudUnavailable,
            status: 503,
          },
});

const invokeCapabilityWithResultSchema = async <TDataSchema extends z.ZodType, TInput = unknown>(
  invocation: CapabilityInvocation<TInput>,
  dataSchema: TDataSchema,
  caller: CapabilityCaller,
): Promise<CapabilityClientResult<z.output<TDataSchema>>> => {
  try {
    const path = caller.mandate
      ? "/api/_internal/identity/v1/invoke"
      : `/api/capabilities/v1/${invocation.kind === "query" ? "queries" : "actions"}/${encodeURIComponent(invocation.appId)}/${encodeURIComponent(invocation.capabilityId)}`;
    const request = await callerRequest(caller, path, invocation.idempotencyKey, invocation.signal);
    if (caller.authority) {
      if (caller.authorization || caller.cookie || caller.mandate) throw new Error("Use exactly one capability authority source");
      const outcome = await dispatchCapability({request,kind:invocation.kind === "query" ? "queries" : "actions",
        appId:invocation.appId,capabilityId:invocation.capabilityId,input:invocation.input,authority:caller.authority,
        locale:caller.locale ?? undefined,origin:caller.origin ?? "app"});
      return readCapabilityResponse(outcome,capabilityResultSchema(dataSchema,{consumer:true}));
    }
    const response = await fetch(request, {
      body: JSON.stringify(
        caller.mandate
          ? {
              kind: invocation.kind,
              targetApp: invocation.appId,
              capabilityId: invocation.capabilityId,
              input: invocation.input,
              mandateId: caller.mandate.id,
              mandateRevision: caller.mandate.revision,
              ...(invocation.idempotencyKey ? { idempotencyKey: invocation.idempotencyKey } : {}),
              ...(caller.requestId || caller.traceparent || caller.tracestate || caller.locale
                ? {
                    metadata: {
                      ...(caller.requestId ? { requestId: caller.requestId } : {}),
                      ...(caller.traceparent ? { traceparent: caller.traceparent } : {}),
                      ...(caller.tracestate ? { tracestate: caller.tracestate } : {}),
                      ...(caller.locale ? { locale: caller.locale } : {}),
                    },
                  }
                : {}),
            }
          : { input: invocation.input },
      ),
    });
    return readCapabilityResponse(response, capabilityResultSchema(dataSchema, { consumer: true }));
  } catch (cause) {
    return unavailable(cause, invocation, caller.locale ?? undefined);
  }
};

export const invokeCapability = <TInput = unknown>(
  invocation: CapabilityInvocation<TInput>,
  caller: CapabilityCaller,
): Promise<CapabilityClientResult<unknown>> => invokeCapabilityWithResultSchema(invocation, z.unknown(), caller);

export const invokeCapabilityWithDataSchema = <TDataSchema extends z.ZodType, TInput = unknown>(
  invocation: CapabilityInvocation<TInput>,
  dataSchema: TDataSchema,
  caller: CapabilityCaller,
): Promise<CapabilityClientResult<z.output<TDataSchema>>> => invokeCapabilityWithResultSchema(invocation, dataSchema, caller);

export const listCapabilityCatalog = async (
  options: { cursor?: string; limit?: number; locale?: string } = {},
): Promise<CapabilityCatalogClientResult> => {
  const limit = options.limit ?? 25;
  const messages = capabilityMessages(options.locale);
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    return {
      ok: false,
      error: { code: "VALIDATION_FAILED", message: messages.catalogLimit({ max: 25 }), status: 400 },
    };
  }
  try {
    return {
      ok: true,
      data: await loadCapabilityCatalogPage({ cursor: options.cursor, limit }, {}, options.locale),
    };
  } catch {
    return { ok: false, error: { code: "APP_UNAVAILABLE", message: messages.cloudUnavailable, status: 503 } };
  }
};

export const getCapabilityCatalogApp = async (appId: string, locale?: string): Promise<CapabilityCatalogAppClientResult> => {
  try {
    const [capability, registeredApp] = await Promise.all([getCapability(appId), getApp(appId)]);
    const presentedApp = registeredApp && locale ? resolveAppPresentation(registeredApp, locale) : registeredApp;
    return {
      ok: true,
      data: capability
        ? {
            appId: capability.appId,
            appName: presentedApp?.name ?? capability.appName,
            appIcon: capability.appIcon,
            appDescription: presentedApp?.description ?? capability.appDescription,
            manifest: locale
              ? resolveCapabilityManifestPresentation(capability.manifest, capability.presentation, locale)
              : capability.manifest,
          }
        : null,
    };
  } catch {
    return { ok: false, error: { code: "APP_UNAVAILABLE", message: capabilityMessages(locale).cloudUnavailable, status: 503 } };
  }
};

export const reviewCapabilityAction = async <TInput = unknown>(
  invocation: Omit<CapabilityInvocation<TInput>, "kind" | "idempotencyKey">,
  caller: CapabilityCaller,
): Promise<CapabilityReviewClientResult> => {
  try {
    if (caller.authority) {
      if (caller.authorization || caller.cookie || caller.mandate) throw new Error("Use exactly one capability authority source");
      const request = await callerRequest(caller,"/api/capabilities/review",undefined,invocation.signal);
      const outcome = await dispatchCapability({request,kind:"actions",review:true,
        appId:invocation.appId,capabilityId:invocation.capabilityId,input:invocation.input,authority:caller.authority,
        locale:caller.locale ?? undefined,origin:caller.origin ?? "app"});
      return readCapabilityResponse(outcome,CapabilityActionReviewSchema);
    }
    const response = await fetch(
      await callerRequest(
        caller,
        `/api/capabilities/v1/actions/${encodeURIComponent(invocation.appId)}/${encodeURIComponent(invocation.capabilityId)}/review`,
        undefined,
        invocation.signal,
      ),
      { body: JSON.stringify({ input: invocation.input }) },
    );
    return readCapabilityResponse(response, CapabilityActionReviewSchema);
  } catch (cause) {
    return unavailable(cause, undefined, caller.locale ?? undefined);
  }
};
