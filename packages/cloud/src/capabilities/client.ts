import { z } from "zod";
import {
  CAPABILITY_FRAMEWORK_ERROR_CODES,
  CAPABILITY_MAX_CATALOG_BYTES,
  CapabilityActionReviewSchema,
  CapabilityCatalogSchema,
  capabilityResultSchema,
} from "../contracts/capabilities";
import { capabilityMessages } from "../shared/capability-messages";
import { LOCALE_HEADER } from "../shared/locale";
import { readCapabilityResponse } from "./response";
import type {
  CapabilityCatalogClientResult,
  CapabilityCatalogOptions,
  CapabilityClientError,
  CapabilityClientResult,
  CapabilityHttpOptions,
  CapabilityInvocation,
  CapabilityReviewClientResult,
} from "./types";

export type {
  CapabilityCatalogClientResult,
  CapabilityCatalogOptions,
  CapabilityClientError,
  CapabilityClientResult,
  CapabilityHttpOptions,
  CapabilityInvocation,
  CapabilityKind,
  CapabilityReviewClientResult,
} from "./types";

const capabilityPath = (invocation: Pick<CapabilityInvocation, "appId" | "capabilityId" | "kind">, review = false): string => {
  const kind = invocation.kind === "query" ? "queries" : "actions";
  return `/capabilities/v1/${kind}/${encodeURIComponent(invocation.appId)}/${encodeURIComponent(invocation.capabilityId)}${review ? "/review" : ""}`;
};

const requestUrl = (baseUrl: string, path: string): string => `${baseUrl.replace(/\/$/, "")}${path}`;

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
        ? { code: CAPABILITY_FRAMEWORK_ERROR_CODES.requestCancelled, message: capabilityMessages(locale).requestCancelled, status: 499 }
        : { code: CAPABILITY_FRAMEWORK_ERROR_CODES.appUnavailable, message: capabilityMessages(locale).cloudUnavailable, status: 503 },
});

const clientLocale = (headers?: HeadersInit): string | undefined => {
  try {
    return new Headers(headers).get(LOCALE_HEADER) ?? (typeof document === "undefined" ? undefined : document.documentElement.lang);
  } catch {
    return typeof document === "undefined" ? undefined : document.documentElement.lang;
  }
};

const invokeCapabilityWithResultSchema = async <TDataSchema extends z.ZodType, TInput = unknown>(
  invocation: CapabilityInvocation<TInput>,
  dataSchema: TDataSchema,
  options: CapabilityHttpOptions = {},
): Promise<CapabilityClientResult<z.output<TDataSchema>>> => {
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  if (invocation.idempotencyKey) headers.set("idempotency-key", invocation.idempotencyKey);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(requestUrl(options.baseUrl ?? "/api", capabilityPath(invocation)), {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({ input: invocation.input }),
      signal: invocation.signal,
    });
    const result = await readCapabilityResponse(response, capabilityResultSchema(dataSchema));
    if (
      invocation.kind === "action" &&
      !invocation.idempotencyKey &&
      !result.ok &&
      (result.error.code === CAPABILITY_FRAMEWORK_ERROR_CODES.invalidAppResponse ||
        result.error.code === CAPABILITY_FRAMEWORK_ERROR_CODES.responseTooLarge)
    ) {
      return unavailable(new Error("Action response was invalid"), invocation, clientLocale(options.headers));
    }
    return result;
  } catch (cause) {
    return unavailable(cause, invocation, clientLocale(options.headers));
  }
};

export const invokeCapability = <TInput = unknown>(
  invocation: CapabilityInvocation<TInput>,
  options: CapabilityHttpOptions = {},
): Promise<CapabilityClientResult<unknown>> => invokeCapabilityWithResultSchema(invocation, z.unknown(), options);

export const invokeCapabilityWithDataSchema = <TDataSchema extends z.ZodType, TInput = unknown>(
  invocation: CapabilityInvocation<TInput>,
  dataSchema: TDataSchema,
  options: CapabilityHttpOptions = {},
): Promise<CapabilityClientResult<z.output<TDataSchema>>> => invokeCapabilityWithResultSchema(invocation, dataSchema, options);

export const listCapabilityCatalog = async (options: CapabilityCatalogOptions = {}): Promise<CapabilityCatalogClientResult> => {
  const query = new URLSearchParams();
  if (options.cursor) query.set("cursor", options.cursor);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const suffix = query.size > 0 ? `?${query}` : "";
  try {
    const response = await (options.fetch ?? globalThis.fetch)(requestUrl(options.baseUrl ?? "/api", `/capabilities/v1/catalog${suffix}`), {
      method: "GET",
      credentials: "same-origin",
      headers: new Headers(options.headers),
      signal: options.signal,
    });
    return readCapabilityResponse(response, CapabilityCatalogSchema, CAPABILITY_MAX_CATALOG_BYTES);
  } catch (cause) {
    return unavailable(cause, undefined, clientLocale(options.headers));
  }
};

export const reviewCapabilityAction = async <TInput = unknown>(
  invocation: Omit<CapabilityInvocation<TInput>, "kind" | "idempotencyKey">,
  options: CapabilityHttpOptions = {},
): Promise<CapabilityReviewClientResult> => {
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  const action = { ...invocation, kind: "action" as const };
  try {
    const response = await (options.fetch ?? globalThis.fetch)(requestUrl(options.baseUrl ?? "/api", capabilityPath(action, true)), {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({ input: invocation.input }),
      signal: invocation.signal,
    });
    return readCapabilityResponse(response, CapabilityActionReviewSchema);
  } catch (cause) {
    return unavailable(cause, undefined, clientLocale(options.headers));
  }
};
