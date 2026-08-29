import { z } from "zod";
import { resolveCapabilityManifestPresentation } from "../_internal/capabilities";
import { getApp, getCapability } from "../_internal/registry";
import { dispatchCapability, loadCapabilityCatalogPage } from "../api/capabilities";
import { CapabilityActionReviewSchema, capabilityResultSchema } from "../contracts/capabilities";
import { resolveAppPresentation } from "../shared/app-presentation";
import { capabilityMessages } from "../shared/capability-messages";
import { LOCALE_HEADER } from "../shared/locale";
import { readCapabilityResponse } from "./response";
import { combineCapabilitySignals } from "./signals";
import type {
  CapabilityCatalogAppClientResult,
  CapabilityCatalogClientResult,
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
  authorization?: string | null;
  cookie?: string | null;
  requestId?: string | null;
  traceparent?: string | null;
  tracestate?: string | null;
  /** BCP 47 locale of the originating request, forwarded as invocation metadata. */
  locale?: string | null;
  signal?: AbortSignal;
};

const callerRequest = (caller: CapabilityCaller, idempotencyKey?: string, invocationSignal?: AbortSignal): Request => {
  const headers = new Headers();
  if (caller.authorization) headers.set("authorization", caller.authorization);
  if (caller.cookie) headers.set("cookie", caller.cookie);
  if (caller.requestId) headers.set("x-request-id", caller.requestId);
  if (caller.traceparent) headers.set("traceparent", caller.traceparent);
  if (caller.tracestate) headers.set("tracestate", caller.tracestate);
  if (caller.locale) headers.set(LOCALE_HEADER, caller.locale);
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  const signal = combineCapabilitySignals(caller.signal, invocationSignal);
  return new Request("http://cloud.internal/api/capabilities/v1", { headers, signal });
};

const invokeCapabilityWithResultSchema = async <TDataSchema extends z.ZodType, TInput = unknown>(
  invocation: CapabilityInvocation<TInput>,
  dataSchema: TDataSchema,
  caller: CapabilityCaller,
): Promise<CapabilityClientResult<z.output<TDataSchema>>> => {
  try {
    const response = await dispatchCapability({
      request: callerRequest(caller, invocation.idempotencyKey, invocation.signal),
      kind: invocation.kind === "query" ? "queries" : "actions",
      appId: invocation.appId,
      capabilityId: invocation.capabilityId,
      input: invocation.input,
    });
    return readCapabilityResponse(response, capabilityResultSchema(dataSchema));
  } catch {
    return { ok: false, error: { code: "APP_UNAVAILABLE", message: capabilityMessages(caller.locale).cloudUnavailable, status: 503 } };
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
    const response = await dispatchCapability({
      request: callerRequest(caller, undefined, invocation.signal),
      kind: "actions",
      review: true,
      appId: invocation.appId,
      capabilityId: invocation.capabilityId,
      input: invocation.input,
    });
    return readCapabilityResponse(response, CapabilityActionReviewSchema);
  } catch {
    return { ok: false, error: { code: "APP_UNAVAILABLE", message: capabilityMessages(caller.locale).cloudUnavailable, status: 503 } };
  }
};
