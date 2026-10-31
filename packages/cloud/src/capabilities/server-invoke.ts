import { z } from "zod";
import { getProcessApplicationId } from "../_internal/process-identity";
import { refreshAppWorkloadCredential } from "../_internal/workload-credential";
import { dispatchCapability, loadCapabilityCatalogPage } from "../api/capabilities";
import { env } from "../config/env";
import {
  CAPABILITY_FRAMEWORK_ERROR_CODES,
  CAPABILITY_MAX_CATALOG_BYTES,
  CAPABILITY_MAX_RESULT_BYTES,
  CapabilityCatalogSchema,
  type CapabilityOrigin,
  capabilityResultSchema,
} from "../contracts/capabilities";
import type { RequestAuthority } from "../server";
import { sendAppRequest } from "../services/identity/app-request";
import { coreOrigin } from "../services/identity/core-origin";
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
  /** Request-local aggregate response budget; called before result validation for every received chunk. */
  consumeResponseBytes?: (bytes: number) => void;
  /** App-only query authority. The platform authenticates each transmission to Core. */
  workload?: { appId: string };
  /** App authority authenticated only by the configured Ed25519 app key. */
  app?: { appId: string };
  /** Durable background authority. The platform authenticates each transmission to Core. */
  mandate?: { id: string; revision: number; callingAppId: string };
};

/** Call as the started application, without a person, service account token, or mandate. */
export const appCaller = (options: Pick<CapabilityCaller, "locale" | "requestId" | "signal"> = {}): CapabilityCaller => {
  const appId = getProcessApplicationId();
  if (!appId) throw new Error("Start the application before creating its capability caller");
  if (!env.CLOUD_APP_KEY) throw new Error("App capability calls require CLOUD_APP_KEY");
  return { ...options, app: { appId }, origin: "app" };
};

export { coreOrigin } from "../services/identity/core-origin";

export const callerRequest = async (
  caller: CapabilityCaller,
  path: string,
  idempotencyKey?: string,
  invocationSignal?: AbortSignal,
): Promise<Request> => {
  const headers = new Headers();
  if (caller.authorization) headers.set("authorization", caller.authorization);
  if (!caller.mandate && !caller.workload && !caller.app) {
    if (caller.cookie) headers.set("cookie", caller.cookie);
    if (caller.requestId) headers.set("x-request-id", caller.requestId);
    if (caller.traceparent) headers.set("traceparent", caller.traceparent);
    if (caller.tracestate) headers.set("tracestate", caller.tracestate);
    if (caller.locale) headers.set(LOCALE_HEADER, caller.locale);
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  } else {
    headers.set("x-cloud-app-id", caller.app?.appId ?? caller.mandate?.callingAppId ?? caller.workload!.appId);
  }
  const signal = combineCapabilitySignals(caller.signal, invocationSignal);
  return new Request(
    new URL(path, await coreOrigin(caller.app !== undefined || caller.mandate !== undefined || caller.workload !== undefined)),
    {
      method: "POST",
      headers,
      signal,
    },
  );
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
    if (
      caller.app &&
      (!env.CLOUD_APP_KEY || caller.authority || caller.authorization || caller.cookie || caller.workload || caller.mandate)
    )
      throw new Error("App calls require one app-key authority source");
    if (caller.workload && (caller.mandate || caller.cookie || invocation.kind !== "query"))
      throw new Error("Workload authority permits only queries without a mandate or cookie");
    const path =
      caller.app || caller.mandate || caller.workload
        ? "/api/_internal/identity/v1/invoke"
        : `/api/capabilities/v1/${invocation.kind === "query" ? "queries" : "actions"}/${encodeURIComponent(invocation.appId)}/${encodeURIComponent(invocation.capabilityId)}`;
    const request = await callerRequest(caller, path, invocation.idempotencyKey, invocation.signal);
    if (caller.authority) {
      if (caller.authorization || caller.cookie || caller.app || caller.mandate || caller.workload || caller.transport)
        throw new Error("Use exactly one capability authority source");
      let charged = false;
      const charge = caller.consumeResponseBytes;
      const outcome = await dispatchCapability({
        request,
        kind: invocation.kind === "query" ? "queries" : "actions",
        appId: invocation.appId,
        capabilityId: invocation.capabilityId,
        input: invocation.input,
        authority: caller.authority,
        locale: caller.locale ?? undefined,
        origin: caller.origin ?? "app",
        ...(charge
          ? {
              consumeResponseBytes: (bytes: number) => {
                charged = true;
                charge(bytes);
              },
            }
          : {}),
      });
      return readCapabilityResponse(
        outcome,
        capabilityResultSchema(dataSchema, { consumer: true }),
        CAPABILITY_MAX_RESULT_BYTES,
        // Only a budgeted caller cancels reading a response that already arrived; others keep the received result.
        charge ? combineCapabilitySignals(caller.signal, invocation.signal) : undefined,
        charged ? undefined : charge,
      );
    }
    const brokerRequest = new Request(request, {
      body: JSON.stringify(
        caller.app || caller.mandate || caller.workload
          ? {
              ...(caller.app ? { appCaller: true } : {}),
              kind: invocation.kind,
              targetApp: invocation.appId,
              capabilityId: invocation.capabilityId,
              input: invocation.input,
              ...(caller.mandate ? { mandateId: caller.mandate.id, mandateRevision: caller.mandate.revision } : {}),
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
    const workloadAppId = caller.app?.appId ?? caller.mandate?.callingAppId ?? caller.workload?.appId;
    const send = (request: Request) =>
      workloadAppId ? sendAppRequest(request, { appId: workloadAppId, transport: caller.transport }) : (caller.transport ?? fetch)(request);
    // Only Core's pre-dispatch legacy rejection is safe to refresh and retry.
    // A configured app key is never downgraded to a reusable credential.
    const retryRequest = workloadAppId ? brokerRequest.clone() : undefined;
    let response = await send(brokerRequest);
    const credentialRejected = (reply: Response) => reply.status === 401 && reply.headers.get("x-cloud-workload-auth") === "required";
    if (!caller.app && workloadAppId && retryRequest && !env.CLOUD_APP_KEY && credentialRejected(response)) {
      await response.body?.cancel();
      let token: string | undefined;
      try {
        token = await refreshAppWorkloadCredential(workloadAppId);
      } catch {
        // This rejection happened before dispatch; credential state is retryable unavailability.
      }
      if (token) retryRequest.headers.set("authorization", `Bearer ${token}`);
      response = await send(retryRequest);
      if (credentialRejected(response)) {
        await response.body?.cancel();
        return unavailable(undefined, undefined, caller.locale ?? undefined);
      }
    }
    return readCapabilityResponse(
      response,
      capabilityResultSchema(dataSchema, { consumer: true }),
      CAPABILITY_MAX_RESULT_BYTES,
      caller.consumeResponseBytes ? combineCapabilitySignals(caller.signal, invocation.signal) : undefined,
      caller.consumeResponseBytes,
    );
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
      if (
        caller.authority &&
        (caller.authorization || caller.cookie || caller.app || caller.mandate || caller.workload || caller.transport)
      )
        throw new Error("Use exactly one capability authority source");
      if (caller.authority)
        return {
          ok: true,
          data: await loadCapabilityCatalogPage({ cursor: options.cursor, limit }, {}, caller.locale ?? options.locale, caller.authority),
        };
      if (caller.app || caller.mandate || caller.workload) throw new Error("Calendar discovery requires request credentials");
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
