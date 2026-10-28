import { z } from "zod";
import { dispatchCapability, loadCapabilityCatalogPage } from "../api/capabilities";
import { env } from "../config/env";
import {
  CAPABILITY_FRAMEWORK_ERROR_CODES,
  CAPABILITY_MAX_CATALOG_BYTES,
  CapabilityCatalogSchema,
  type CapabilityOrigin,
  capabilityResultSchema,
} from "../contracts/capabilities";
import type { RequestAuthority } from "../server";
import { get } from "../services/settings";
import { publicCloudOrigin } from "../shared/app-url";
import { capabilityMessages } from "../shared/capability-messages";
import { LOCALE_HEADER } from "../shared/locale";
import { readCapabilityResponse } from "./response";
import { combineCapabilitySignals } from "./signals";
import type { CapabilityCatalogClientResult, CapabilityClientError, CapabilityClientResult, CapabilityInvocation } from "./types";

/**
 * The server capability client: the caller's credentials, the request to Core, invocation, and the catalog. Its own
 * module, so readers built on it, such as the calendar reader, and the public `capabilities/server` entry share it.
 */

export type CapabilityCaller = {
  /** Core-only in-process authority; other applications must use a Core transport. */
  authority?: RequestAuthority;
  /** Trusted server transport to Core. Never supplied by a browser or sandbox. */
  transport?: (request: Request) => Promise<Response>;
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

export const coreOrigin = async (internal = false): Promise<string> => {
  const configured = env.CLOUD_CORE_INTERNAL_ORIGIN;
  if (internal && !configured) throw new Error("CLOUD_CORE_INTERNAL_ORIGIN is required for mandate-backed invocation");
  const origin = configured || publicCloudOrigin(await get<string>("app.url"));
  const url = new URL(origin);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("CLOUD_CORE_INTERNAL_ORIGIN must use http or https");
  return url.origin;
};

export const callerRequest = async (
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

export const unavailable = (
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
      if (caller.authorization || caller.cookie || caller.mandate || caller.transport)
        throw new Error("Use exactly one capability authority source");
      const outcome = await dispatchCapability({
        request,
        kind: invocation.kind === "query" ? "queries" : "actions",
        appId: invocation.appId,
        capabilityId: invocation.capabilityId,
        input: invocation.input,
        authority: caller.authority,
        locale: caller.locale ?? undefined,
        origin: caller.origin ?? "app",
      });
      return readCapabilityResponse(outcome, capabilityResultSchema(dataSchema, { consumer: true }));
    }
    const response = await (caller.transport ?? fetch)(
      new Request(request, {
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
      }),
    );
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
  options: { cursor?: string; limit?: number; locale?: string; authority?: RequestAuthority | null; caller?: CapabilityCaller } = {},
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
    if (options.caller) {
      const caller = options.caller;
      if (options.authority) throw new Error("Use one catalog authority source");
      if (caller.authority && (caller.authorization || caller.cookie || caller.mandate || caller.transport))
        throw new Error("Use exactly one capability authority source");
      if (caller.authority)
        return {
          ok: true,
          data: await loadCapabilityCatalogPage({ cursor: options.cursor, limit }, {}, caller.locale ?? options.locale, caller.authority),
        };
      if (caller.mandate) throw new Error("Calendar discovery requires request credentials");
      const query = new URLSearchParams({ limit: String(limit) });
      if (options.cursor) query.set("cursor", options.cursor);
      const request = new Request(await callerRequest(caller, `/api/capabilities/v1/catalog?${query}`), { method: "GET" });
      return await readCapabilityResponse(
        await (caller.transport ?? fetch)(request),
        CapabilityCatalogSchema,
        CAPABILITY_MAX_CATALOG_BYTES,
        caller.signal,
      );
    }
    return {
      ok: true,
      data: await loadCapabilityCatalogPage({ cursor: options.cursor, limit }, {}, options.locale, options.authority ?? null),
    };
  } catch {
    return { ok: false, error: { code: "APP_UNAVAILABLE", message: messages.cloudUnavailable, status: 503 } };
  }
};
