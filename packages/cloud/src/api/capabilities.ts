import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { readBoundedJson } from "../_internal/bounded-json";
import { resolveCapabilityManifestPresentation } from "../_internal/capabilities";
import {
  capabilityActionReceiptIssues,
  capabilityActionReviewIssues,
  capabilityQueryChecksActionOutcome,
} from "../_internal/capability-reviews";
import { capabilityTimeoutMs, createCapabilityDeadline, withCapabilityRequestTimeout } from "../_internal/capability-timeout";
import { getCapability, listApps } from "../_internal/registry";
import { resolveCommandLink } from "../capabilities/command-link";
import {
  type CapabilityClaimScope,
  type CapabilityExecutionStatus,
  capabilityIdempotencyKeyHash,
  capabilityRequestHash,
  capabilityValueMeta,
  claimCapabilityIdempotency,
  completeCapabilityClaim,
  markCapabilityClaimUncertain,
  recordCapabilityExecution,
  releaseCapabilityClaim,
  resolveCapabilityClaim,
} from "../capabilities/executions";
import {
  CAPABILITY_FRAMEWORK_ERROR_CODES,
  CAPABILITY_MAX_CATALOG_BYTES,
  CAPABILITY_MAX_REQUEST_BYTES,
  CAPABILITY_MAX_RESULT_BYTES,
  CAPABILITY_ORIGIN_HEADER,
  CAPABILITY_PROTOCOL_VERSION,
  CapabilityActionReviewDataSchema,
  type CapabilityCatalog,
  CapabilityCatalogSchema,
  CapabilityErrorSchema,
  CapabilityIdempotencyKeySchema,
  type CapabilityOrigin,
  capabilityActionPolicy,
  capabilityResultJsonSchema,
} from "../contracts/capabilities";
import { CapabilityStreamSchema } from "../contracts/capability-streams";
import { CommandLinkSchema, CommandRequestSchema } from "../contracts/commands";
import type { AppRegistryEntry, CapabilityRegistryEntry } from "../contracts/registry";
import { getLocale, LOCALE_HEADER, preferredLocale } from "../server/locale";
import {
  type AuthContext,
  auth,
  jsonResponse,
  type RequestAuthority,
  rejectReservedWorkloadCredential,
  requiresAuth,
  v,
} from "../server/middleware";
import { noTransform } from "../server/middleware/no-transform";
import { invocationAuthorityFromRequest } from "../services/identity/invocation-authority";
import { capabilityInvocationOperation } from "../services/identity/invocation-operations";
import type { InvocationAuthority } from "../services/identity/invocation-token";
import { normalizeInvocationRequestId, signInvocationToken } from "../services/identity/invocation-token";
import { withActiveIdentitySigner } from "../services/identity/key-ring";
import { logger } from "../services/logging";
import { withMandateIssueAuthority } from "../services/mandates";
import * as settings from "../services/settings";
import { resolveAppPresentation } from "../shared/app-presentation";
import { capabilityMessages } from "../shared/capability-messages";
import { dispatchCapabilityStream, sealCapabilityStream } from "./capability-streams";

const log = logger("capabilities");
const DEFAULT_CATALOG_LIMIT = 10;
const MAX_CATALOG_LIMIT = 25;
const MAX_SCHEMA_VALIDATORS = 512;

const schemaValidators = new Map<string, z.ZodType | null>();

const schemaValidator = (key: string, schema: Record<string, unknown>): z.ZodType | null => {
  if (schemaValidators.has(key)) return schemaValidators.get(key) ?? null;
  let validator: z.ZodType | null = null;
  try {
    validator = z.fromJSONSchema(schema);
  } catch {
    // A live manifest with an unsupported schema is unusable, but must not
    // crash the dispatcher serving unrelated applications.
  }
  if (schemaValidators.size >= MAX_SCHEMA_VALIDATORS) {
    const oldest = schemaValidators.keys().next().value;
    if (oldest) schemaValidators.delete(oldest);
  }
  schemaValidators.set(key, validator);
  return validator;
};

const CapabilityInvocationRequestSchema = z.object({ input: z.unknown() }).strict();
const CapabilityCatalogQuerySchema = z
  .object({
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_CATALOG_LIMIT).default(DEFAULT_CATALOG_LIMIT),
  })
  .strict();
export type CapabilityRouteDependencies = {
  listApps?: () => Promise<AppRegistryEntry[]>;
  getCapability?: (appId: string) => Promise<CapabilityRegistryEntry | null>;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  authenticate?: MiddlewareHandler<AuthContext>;
  signInvocation?: typeof signInvocationToken;
  withActiveSigner?: typeof withActiveIdentitySigner;
  withMandateIssueAuthority?: typeof withMandateIssueAuthority;
  queryTimeoutMs?: number;
  actionTimeoutMs?: number;
  reviewTimeoutMs?: number;
  appUrl?: () => Promise<string>;
};

export type CapabilityDispatchDependencies = Pick<
  CapabilityRouteDependencies,
  | "getCapability"
  | "fetch"
  | "queryTimeoutMs"
  | "actionTimeoutMs"
  | "reviewTimeoutMs"
  | "signInvocation"
  | "withActiveSigner"
  | "withMandateIssueAuthority"
>;

type MandatedCapabilityAuthority = {
  mandateId: string;
  mandateRevision: number;
  ownerAppId: string;
  /** Internal proof from a completed approval flow. Public broker input cannot set this. */
  actionApproval?: "approved";
};

const invocationAuthorityFromMandate = (authority: {
  mandateId: string;
  mandateRevision: number;
  subject: { type: "user" | "service_account"; id: string };
  workloadType: string;
  workloadId: string;
}): InvocationAuthority => ({
  sub: authority.subject.id,
  principal_type: authority.subject.type,
  access_subject_type: authority.subject.type,
  access_subject_id: authority.subject.id,
  credential_kind: "mandate",
  scopes: [],
  mandate_id: authority.mandateId,
  mandate_revision: authority.mandateRevision,
  workload_type: authority.workloadType,
  workload_id: authority.workloadId,
});

export const loadCapabilityCatalogPage = async (
  query: { cursor?: string; limit: number },
  dependencies: Pick<CapabilityRouteDependencies, "listApps" | "getCapability"> = {},
  locale?: string,
): Promise<CapabilityCatalog> => {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_CATALOG_LIMIT) {
    throw new RangeError(`Capability catalog limit must be between 1 and ${MAX_CATALOG_LIMIT}`);
  }
  const registry = dependencies.listApps ?? listApps;
  const capabilityLookup = dependencies.getCapability ?? getCapability;
  const entries = await registry();
  const liveApps = entries
    .filter((entry) => entry.capabilities?.protocolVersion === CAPABILITY_PROTOCOL_VERSION)
    .sort((left, right) => left.id.localeCompare(right.id));
  const start = query.cursor ? liveApps.findIndex((entry) => entry.id > query.cursor!) : 0;
  const offset = start < 0 ? liveApps.length : start;
  const apps: CapabilityCatalog["apps"] = [];
  let bytes = 0;
  let lastScannedAppId: string | undefined;
  const envelopeBytes = new TextEncoder().encode(
    JSON.stringify({
      protocolVersion: CAPABILITY_PROTOCOL_VERSION,
      apps: [],
      page: { hasMore: true, nextCursor: "x".repeat(80) },
    }),
  ).byteLength;
  for (const entry of liveApps.slice(offset)) {
    if (apps.length === query.limit) break;
    const capability = await capabilityLookup(entry.id);
    if (!capability || capability.manifest.manifestHash !== entry.capabilities?.manifestHash) {
      lastScannedAppId = entry.id;
      continue;
    }
    const presentedEntry = locale ? resolveAppPresentation(entry, locale) : entry;
    const projected = {
      appId: capability.appId,
      appName: presentedEntry.name,
      appIcon: capability.appIcon,
      appDescription: presentedEntry.description,
      manifest: locale ? resolveCapabilityManifestPresentation(capability.manifest, capability.presentation, locale) : capability.manifest,
    };
    const projectedBytes = new TextEncoder().encode(JSON.stringify(projected)).byteLength;
    const separatingCommas = apps.length;
    if (apps.length > 0 && envelopeBytes + bytes + separatingCommas + projectedBytes > CAPABILITY_MAX_CATALOG_BYTES) break;
    apps.push(projected);
    bytes += projectedBytes;
    lastScannedAppId = entry.id;
  }
  const hasMore = lastScannedAppId !== undefined && liveApps.some((entry) => entry.id > lastScannedAppId);
  const page: CapabilityCatalog["page"] =
    hasMore && lastScannedAppId ? { hasMore: true, nextCursor: lastScannedAppId } : { hasMore: false };
  return {
    protocolVersion: CAPABILITY_PROTOCOL_VERSION,
    apps,
    page,
  };
};

const errorResponse = (code: string, message: string, status: number, details?: Record<string, unknown>) => ({
  body: { code, message, ...(details ? { details } : {}) },
  status,
});

const capabilityJsonResponse = (body: unknown, status: number): Response =>
  Response.json(body, {
    status,
    headers: { "content-type": "application/json" },
  });

export type CapabilityDispatchParams = {
  /** Trusted Core continuation binding; never read from client headers. */
  continuation?: string;
  request: Request;
  kind: "queries" | "actions";
  review?: boolean;
  appId: string;
  capabilityId: string;
  input: unknown;
  locale?: string;
  /** Cloud surface this invocation came from; recorded on the execution row. */
  origin: CapabilityOrigin;
  authority?: RequestAuthority;
  mandate?: MandatedCapabilityAuthority;
  callingAppId?: string;
  /** Internal observation only: called immediately before attempting the app request. */
  onUpstreamAttempt?: () => void;
  dependencies?: CapabilityDispatchDependencies;
};

type CapabilityDispatchOutcome = { body: unknown; status: number; replayed?: boolean };

/** Principal resolved while dispatching. A mandate only reveals it during issuance. */
type CapabilityDispatchObservation = {
  subject: { type: "user" | "service_account"; id: string } | null;
  destructive: boolean;
};

type CapabilityPrincipal = { type: "user" | "service_account"; id: string } | null;

/** Acting principal for the execution row and the idempotency claim scope. A mandate reveals it during issuance. */
const dispatchPrincipal = (params: CapabilityDispatchParams, observed: CapabilityDispatchObservation): CapabilityPrincipal => {
  const actor = params.authority?.actor;
  if (actor?.kind === "user") return { type: "user", id: actor.user.id };
  if (actor?.kind === "service_account") return { type: "service_account", id: actor.serviceAccount.id };
  return observed.subject;
};

const runCapabilityDispatch = async (
  params: CapabilityDispatchParams,
  requestId: string,
  observed: CapabilityDispatchObservation,
  deadline: ReturnType<typeof createCapabilityDeadline>,
): Promise<CapabilityDispatchOutcome> => {
  const { signal } = deadline;
  const messages = capabilityMessages(params.locale ?? preferredLocale(params.request.headers));
  const registryEntry = params.dependencies?.getCapability ?? getCapability;
  const fetchUpstream = params.dependencies?.fetch ?? globalThis.fetch;
  let entry: CapabilityRegistryEntry | null;
  try {
    entry = await deadline.wait(() => registryEntry(params.appId));
  } catch (error) {
    deadline.check();
    log.warn("Capability registry unavailable", {
      appId: params.appId,
      error: error instanceof Error ? error.message : String(error),
    });
    const unavailable = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.appUnavailable, messages.registryUnavailable, 503);
    return unavailable;
  }
  if (!entry) {
    const error = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.appUnavailable, messages.appUnavailable({ appId: params.appId }), 503);
    return error;
  }

  const operations = params.kind === "queries" ? entry.manifest.queries : entry.manifest.actions;
  const operation = operations.find((candidate) => candidate.localId === params.capabilityId);
  if (operation && "destructive" in operation) observed.destructive = operation.destructive;
  if (!operation) {
    const label = params.kind === "queries" ? messages.query : messages.action;
    const error = errorResponse(
      "CAPABILITY_NOT_FOUND",
      messages.notFound({ kind: label, reference: `${params.appId}.${params.capabilityId}` }),
      404,
    );
    return error;
  }
  if (params.review && (params.kind !== "actions" || !("review" in operation) || operation.review !== true)) {
    const error = errorResponse(
      "CAPABILITY_NOT_FOUND",
      messages.notFound({ kind: messages.review, reference: `${params.appId}.${params.capabilityId}` }),
      404,
    );
    return error;
  }

  const rawIdempotencyKey = params.request.headers.get("idempotency-key");
  if (params.kind === "actions" && !params.review) {
    const action = operation as (typeof entry.manifest.actions)[number];
    if (action.idempotency === "required" && rawIdempotencyKey === null) {
      const error = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.idempotencyKeyRequired, messages.idempotencyRequired, 400);
      return error;
    }
    if (action.idempotency === "none" && rawIdempotencyKey !== null) {
      const error = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.idempotencyKeyNotAllowed, messages.idempotencyNotAllowed, 400);
      return error;
    }
  } else if (rawIdempotencyKey !== null) {
    const error = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.idempotencyKeyNotAllowed, messages.idempotencyOnlyActions, 400);
    return error;
  }
  const idempotencyKey = rawIdempotencyKey === null ? null : CapabilityIdempotencyKeySchema.safeParse(rawIdempotencyKey);
  if (idempotencyKey && !idempotencyKey.success) {
    const error = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.validationFailed, messages.idempotencyInvalid, 400, {
      issues: idempotencyKey.error.issues.map((issue) => ({ message: issue.message })),
    });
    return error;
  }

  const inputValidator = schemaValidator(`${operation.schemaHash}:input`, operation.inputSchema);
  if (!inputValidator) {
    const invalid = errorResponse("INVALID_APP_RESPONSE", messages.unsupportedSchema({ appId: params.appId }), 502);
    return invalid;
  }
  const input = inputValidator.safeParse(params.input);
  if (!input.success) {
    const invalid = errorResponse("VALIDATION_FAILED", messages.inputSchemaMismatch, 400, {
      issues: input.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
    return invalid;
  }

  if (params.mandate && operation.stream)
    return errorResponse("STREAM_UNSUPPORTED_AUTHORITY", "Streams require an interactive user or service-account request", 403);

  let requestBody: string;
  try {
    requestBody = JSON.stringify({ input: input.data });
  } catch {
    const invalid = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.validationFailed, messages.inputNotSerializable, 400);
    return invalid;
  }
  if (new TextEncoder().encode(requestBody).byteLength > CAPABILITY_MAX_REQUEST_BYTES) {
    const invalid = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.validationFailed, messages.requestTooLarge, 400);
    return invalid;
  }

  const invocationOperation = capabilityInvocationOperation(params.kind, params.capabilityId, params.review);
  const mandate = params.mandate;
  let headers: Headers;
  try {
    headers = mandate
      ? await (async () => {
          const issued = await deadline.wait(() =>
            (params.dependencies?.withActiveSigner ?? withActiveIdentitySigner)(
              "invocation",
              (signer, db) => {
                deadline.check();
                return (params.dependencies?.withMandateIssueAuthority ?? withMandateIssueAuthority)(
                  {
                    mandateId: mandate.mandateId,
                    expectedRevision: mandate.mandateRevision,
                    ownerAppId: mandate.ownerAppId,
                    targetAppId: params.appId,
                    operation: invocationOperation,
                    actionApproval: mandate.actionApproval ?? "none",
                    input: params.input,
                    capabilityApproval: "approval" in operation ? (operation.approval ?? "always") : "always",
                    capabilityPolicy: capabilityActionPolicy(entry.manifest, params.capabilityId),
                    requestId,
                  },
                  async (mandateAuthority) => {
                    deadline.check();
                    observed.subject = mandateAuthority.subject;
                    return (params.dependencies?.signInvocation ?? signInvocationToken)({
                      targetAppId: params.appId,
                      callingAppId: mandate.ownerAppId,
                      operation: invocationOperation,
                      schemaHash: operation.schemaHash,
                      authority: invocationAuthorityFromMandate(mandateAuthority),
                      requestId,
                      signer,
                      issuer: signer.issuer,
                    });
                  },
                  { db },
                );
              },
              { signal, timeoutMs: deadline.remainingMs() },
            ),
          );
          if (!issued.ok) {
            if (issued.error.code === "INTERNAL") throw new Error("Mandate invocation issuance failed");
            throw new MandateDispatchError(issued.error.code === "CONFLICT" ? 409 : 403);
          }
          return new Headers({
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${issued.data.token}`,
          });
        })()
      : await (async () => {
          if (!params.authority) throw new Error("Resolved request authority is required for Cloud invocation issuance");
          const authority = params.authority;
          const signed = await deadline.wait(() =>
            (params.dependencies?.withActiveSigner ?? withActiveIdentitySigner)(
              "invocation",
              (signer) => {
                deadline.check();
                return (params.dependencies?.signInvocation ?? signInvocationToken)({
                  targetAppId: params.appId,
                  callingAppId: params.callingAppId ?? "core",
                  operation: invocationOperation,
                  schemaHash: operation.schemaHash,
                  authority: invocationAuthorityFromRequest(authority),
                  requestId,
                  signer,
                  issuer: signer.issuer,
                });
              },
              { signal, timeoutMs: deadline.remainingMs() },
            ),
          );
          return new Headers({
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${signed.token}`,
          });
        })();
  } catch (error) {
    if (error instanceof MandateDispatchError) {
      const denied = errorResponse(
        error.status === 409 ? "MANDATE_REVISION_CHANGED" : "MANDATE_FORBIDDEN",
        error.status === 409 ? "Mandate revision changed" : "Mandate does not authorize this capability invocation",
        error.status,
      );
      return denied;
    }
    if (signal.aborted) {
      const cancelled = params.request.signal.aborted;
      const failure = errorResponse(
        cancelled ? CAPABILITY_FRAMEWORK_ERROR_CODES.requestCancelled : CAPABILITY_FRAMEWORK_ERROR_CODES.deadlineExceeded,
        cancelled ? messages.requestCancelled : messages.deadlineExceeded,
        cancelled ? 499 : 504,
        { retrySafe: true },
      );
      return failure;
    }
    console.error("[capabilities] Invocation issuance failed", { appId: params.appId, operation: invocationOperation });
    const failure = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.internal, messages.issuanceFailed, 500, { retrySafe: true });
    return failure;
  }
  deadline.check();
  headers.set("x-request-id", requestId);
  headers.set(CAPABILITY_ORIGIN_HEADER, params.origin);
  for (const name of ["traceparent", "tracestate"] as const) {
    const value = params.request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const invocationLocale = preferredLocale(params.request.headers);
  if (invocationLocale) headers.set(LOCALE_HEADER, invocationLocale);
  if (idempotencyKey?.success) headers.set("idempotency-key", idempotencyKey.data);
  headers.set("x-cloud-capability-schema-hash", operation.schemaHash);
  const actionWithoutRetrySafety =
    params.kind === "actions" && !params.review && "idempotency" in operation && operation.idempotency === "none";
  const outcomeUnknown = (): CapabilityDispatchOutcome => {
    const unknown = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.actionOutcomeUnknown, messages.actionOutcomeUnknown, 502, {
      retrySafe: false,
    });
    return unknown;
  };

  const claimPrincipal = dispatchPrincipal(params, observed);
  const claimScope: CapabilityClaimScope | null =
    params.kind === "actions" &&
    !params.review &&
    "idempotency" in operation &&
    operation.idempotency === "required" &&
    idempotencyKey?.success
      ? {
          appId: params.appId,
          capability: `${params.appId}.${params.capabilityId}`,
          principal: claimPrincipal ? `${claimPrincipal.type}:${claimPrincipal.id}` : "anonymous",
          keyHash: capabilityIdempotencyKeyHash(idempotencyKey.data),
        }
      : null;
  if (claimScope) {
    let claim: Awaited<ReturnType<typeof claimCapabilityIdempotency>>;
    try {
      claim = await claimCapabilityIdempotency(claimScope, capabilityRequestHash(input.data));
    } catch (error) {
      // Nothing has been forwarded yet, so refusing the call is the safe answer.
      log.error("Capability idempotency claim failed", {
        appId: params.appId,
        capabilityId: params.capabilityId,
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.internal, messages.cloudUnavailable, 503, { retrySafe: true });
    }
    if (claim.state === "replay") return { body: claim.body, status: claim.status, replayed: true };
    if (claim.state === "conflict")
      return errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.idempotencyConflict, messages.idempotencyConflict, 409);
    if (claim.state === "in_flight") {
      return errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.idempotencyInProgress, messages.idempotencyInProgress, 409, {
        retrySafe: false,
      });
    }
    if (claim.state === "uncertain") {
      return errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.idempotencyUncertain, messages.idempotencyUncertain, 409, { retrySafe: false });
    }
    if (claim.state === "not_retained") {
      return errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.idempotencyUncertain, messages.idempotencyResultNotRetained, 409, {
        retrySafe: false,
      });
    }
  }

  /**
   * Resolve the claim once the outcome is known: a definitive success is
   * replayable, a failure that proves nothing happened frees the key for a
   * corrected retry, and anything ambiguous freezes the key.
   */
  const settle = async (outcome: CapabilityDispatchOutcome, disposition: "succeeded" | "nothing_happened" | "uncertain") => {
    if (!claimScope) return outcome;
    await resolveCapabilityClaim(
      disposition === "succeeded"
        ? completeCapabilityClaim(claimScope, outcome.status, outcome.body)
        : disposition === "nothing_happened"
          ? releaseCapabilityClaim(claimScope)
          : markCapabilityClaimUncertain(claimScope),
      claimScope,
    );
    return outcome;
  };

  // Claims are mutations: await their settlement, then refuse any late upstream start.
  try {
    deadline.check();
  } catch {
    const cancelled = params.request.signal.aborted;
    return settle(
      errorResponse(
        cancelled ? CAPABILITY_FRAMEWORK_ERROR_CODES.requestCancelled : CAPABILITY_FRAMEWORK_ERROR_CODES.deadlineExceeded,
        cancelled ? messages.requestCancelled : messages.deadlineExceeded,
        cancelled ? 499 : 504,
        { retrySafe: true },
      ),
      "nothing_happened",
    );
  }

  let response: Response;
  try {
    params.onUpstreamAttempt?.();
    const fetchResponse = () =>
      fetchUpstream(`${entry.endpoint}/${params.kind}/${encodeURIComponent(params.capabilityId)}${params.review ? "/review" : ""}`, {
        method: "POST",
        headers,
        body: requestBody,
        signal,
      });
    // A read may be released at its deadline; Action effects retain their existing uncertainty handling.
    response = params.kind === "queries" || params.review ? await deadline.wait(fetchResponse) : await fetchResponse();
  } catch (error) {
    log.warn("Capability app unavailable", {
      appId: params.appId,
      capabilityId: params.capabilityId,
      kind: params.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    if (actionWithoutRetrySafety) return settle(outcomeUnknown(), "uncertain");
    if (params.request.signal.aborted) {
      const cancelled = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.requestCancelled, messages.requestCancelled, 499, {
        retrySafe: params.kind === "queries" || ("idempotency" in operation && operation.idempotency === "required"),
      });
      return settle(cancelled, "uncertain");
    }
    if (signal.aborted) {
      const deadline = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.deadlineExceeded, messages.deadlineExceeded, 504, {
        retrySafe: params.kind === "queries" || ("idempotency" in operation && operation.idempotency === "required"),
      });
      return settle(deadline, "uncertain");
    }
    const unavailable = errorResponse(
      CAPABILITY_FRAMEWORK_ERROR_CODES.appUnavailable,
      messages.appCouldNotServe({ appId: params.appId }),
      503,
      { retrySafe: params.kind === "queries" || ("idempotency" in operation && operation.idempotency === "required") },
    );
    return settle(unavailable, "uncertain");
  }

  let upstreamBody: Awaited<ReturnType<typeof readBoundedJson>>;
  try {
    upstreamBody = await deadline.wait(() => readBoundedJson(response, CAPABILITY_MAX_RESULT_BYTES, signal));
  } catch {
    if (actionWithoutRetrySafety) return settle(outcomeUnknown(), "uncertain");
    const cancelled = params.request.signal.aborted;
    return settle(
      errorResponse(
        cancelled ? CAPABILITY_FRAMEWORK_ERROR_CODES.requestCancelled : CAPABILITY_FRAMEWORK_ERROR_CODES.deadlineExceeded,
        cancelled ? messages.requestCancelled : messages.deadlineExceeded,
        cancelled ? 499 : 504,
        { retrySafe: true },
      ),
      "uncertain",
    );
  }
  if (!upstreamBody.ok) {
    if (actionWithoutRetrySafety) return settle(outcomeUnknown(), "uncertain");
    const code =
      upstreamBody.reason === "too_large"
        ? CAPABILITY_FRAMEWORK_ERROR_CODES.responseTooLarge
        : CAPABILITY_FRAMEWORK_ERROR_CODES.invalidAppResponse;
    const invalid = errorResponse(code, messages.invalidCapabilityJson({ appId: params.appId }), 502);
    return settle(invalid, "uncertain");
  }

  if (!response.ok) {
    const parsed = CapabilityErrorSchema.safeParse(upstreamBody.data);
    if (parsed.success && response.status >= 400 && response.status <= 599) {
      // A 4xx from the owning app is a decision about the request itself and
      // proves the effect did not happen; a 5xx proves nothing.
      return settle({ body: parsed.data, status: response.status }, response.status < 500 ? "nothing_happened" : "uncertain");
    }
    if (actionWithoutRetrySafety) return settle(outcomeUnknown(), "uncertain");
    const invalid = errorResponse("INVALID_APP_RESPONSE", messages.invalidCapabilityError({ appId: params.appId }), 502);
    return settle(invalid, "uncertain");
  }

  const reviewContext = {
    policy: capabilityActionPolicy(entry.manifest, params.capabilityId),
    approval: "approval" in operation ? operation.approval : undefined,
    queries: entry.manifest.queries,
    validateQueryInput: (query: (typeof entry.manifest.queries)[number], input: Record<string, unknown>) =>
      schemaValidator(`${query.schemaHash}:input`, query.inputSchema)?.safeParse(input).success === true,
    ...(entry.presentation ? { locales: [entry.presentation.baseLocale, ...Object.keys(entry.presentation.translations)] } : {}),
  };
  const resultValidator = params.review
    ? CapabilityActionReviewDataSchema
    : schemaValidator(`${operation.schemaHash}:result`, capabilityResultJsonSchema(operation.dataSchema));
  const parsedResult = resultValidator?.safeParse(upstreamBody.data);
  const field = (value: unknown, key: string): unknown =>
    value !== null && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  const receipt = field(upstreamBody.data, "receipt");
  const links = field(upstreamBody.data, "links");
  const reviewIssues = params.review
    ? capabilityActionReviewIssues(upstreamBody.data, reviewContext)
    : receipt === undefined
      ? []
      : params.kind === "queries"
        ? ["Queries cannot return a receipt"]
        : capabilityActionReceiptIssues(receipt, links);
  const nestedReceipt = field(field(upstreamBody.data, "data"), "receipt");
  if (
    !params.review &&
    params.kind === "queries" &&
    nestedReceipt !== undefined &&
    !("idempotency" in operation) &&
    capabilityQueryChecksActionOutcome(operation)
  )
    reviewIssues.push(...capabilityActionReceiptIssues(nestedReceipt, links));
  if (!resultValidator || !parsedResult?.success || reviewIssues.length > 0) {
    if (actionWithoutRetrySafety) return settle(outcomeUnknown(), "uncertain");
    const invalid = errorResponse("INVALID_APP_RESPONSE", messages.outsideResultSchema({ appId: params.appId }), 502);
    return settle(invalid, "uncertain");
  }

  const body = upstreamBody.data as Record<string, unknown>;
  if (!params.review && body.stream !== undefined) {
    const stream = CapabilityStreamSchema.safeParse(body.stream);
    const authority = params.authority;
    if (
      !stream.success ||
      !operation.stream ||
      stream.data.direction !== operation.stream.direction ||
      stream.data.size > operation.stream.maxBytes ||
      Date.parse(stream.data.expiresAt) <= Date.now() ||
      Date.parse(stream.data.expiresAt) > Date.now() + 86_400_000 ||
      !authority
    )
      return settle(errorResponse("INVALID_APP_RESPONSE", "Invalid stream offer", 502), "uncertain");
    try {
      const seal = () =>
        sealCapabilityStream(stream.data, {
          appId: params.appId,
          kind: params.kind,
          capabilityId: params.capabilityId,
          schemaHash: operation.schemaHash,
          authority,
          requestId,
          origin: params.origin,
          continuation: params.continuation,
        });
      body.stream = params.kind === "queries" ? await deadline.wait(seal) : await seal();
      if (Buffer.byteLength(JSON.stringify(body)) > CAPABILITY_MAX_RESULT_BYTES) throw new Error("Stream result too large");
    } catch {
      if (params.kind === "queries") deadline.check();
      return settle(errorResponse("INVALID_APP_RESPONSE", "Invalid stream offer", 502), "uncertain");
    }
  }
  if (params.kind === "queries" || params.review) deadline.check();
  return settle({ body, status: 200 }, "succeeded");
};

const executionStatus = (status: number, code: string | null): CapabilityExecutionStatus => {
  if (status < 400) return "succeeded";
  if (status === 400) return "invalid_input";
  if (status === 401 || status === 403) return "denied";
  if (status === 504 || code === CAPABILITY_FRAMEWORK_ERROR_CODES.deadlineExceeded) return "timed_out";
  return "failed";
};

const bodyErrorCode = (body: unknown): string | null =>
  body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : null;

const resultDataMeta = (body: unknown) =>
  capabilityValueMeta(body && typeof body === "object" && "data" in body ? (body as { data: unknown }).data : body);

/**
 * Dispatch one already-parsed capability invocation through the live registry.
 * HTTP, MCP, and assistant callers share this exact app lookup, credential
 * forwarding, schema pinning, timeout, and response validation path.
 *
 * One invocation
 * produces exactly one execution row, whatever its outcome. Binary stream
 * continuations record their own row under the same request ID. Action reviews are a
 * read-only preview and are not executions, so they are not recorded.
 */
export const dispatchCapability = async (params: CapabilityDispatchParams): Promise<Response> => {
  const deadline = createCapabilityDeadline(
    capabilityTimeoutMs(params.review ? "review" : params.kind === "queries" ? "query" : "action", params.dependencies),
    params.request.signal,
  );
  try {
    const requestId = normalizeInvocationRequestId(params.request.headers.get("x-request-id")) ?? crypto.randomUUID();
    const observed: CapabilityDispatchObservation = { subject: null, destructive: false };
    const startedAt = new Date();
    let outcome: CapabilityDispatchOutcome;
    try {
      outcome = await runCapabilityDispatch(params, requestId, observed, deadline);
    } catch (error) {
      if (!deadline.signal.aborted) throw error;
      const cancelled = params.request.signal.aborted;
      const messages = capabilityMessages(params.locale ?? preferredLocale(params.request.headers));
      outcome = errorResponse(
        cancelled ? CAPABILITY_FRAMEWORK_ERROR_CODES.requestCancelled : CAPABILITY_FRAMEWORK_ERROR_CODES.deadlineExceeded,
        cancelled ? messages.requestCancelled : messages.deadlineExceeded,
        cancelled ? 499 : 504,
        { retrySafe: true },
      );
    }
    if (!params.review) {
      const actor = params.authority?.actor;
      const principal = dispatchPrincipal(params, observed);
      const accessSubject = params.authority?.accessSubject;
      const subject =
        accessSubject?.type === "user"
          ? ({ type: "user", id: accessSubject.userId } as const)
          : accessSubject?.type === "service_account"
            ? ({ type: "service_account", id: accessSubject.serviceAccountId } as const)
            : null;
      const errorCode = outcome.status >= 400 ? bodyErrorCode(outcome.body) : null;
      const recording = recordCapabilityExecution({
        requestId,
        origin: params.origin,
        appId: params.appId,
        capability: `${params.appId}.${params.capabilityId}`,
        kind: params.kind === "queries" ? "query" : "action",
        destructive: observed.destructive,
        actorKind: principal?.type ?? null,
        actorId: principal?.id ?? null,
        userId: actor?.kind === "user" ? actor.user.id : (actor?.delegatedUser?.id ?? (principal?.type === "user" ? principal.id : null)),
        accessSubject: subject && subject.id !== principal?.id ? subject : null,
        status: executionStatus(outcome.status, errorCode),
        errorCode,
        inputMeta: capabilityValueMeta(params.input),
        outputMeta: outcome.status < 400 ? resultDataMeta(outcome.body) : null,
        idempotencyKey: CapabilityIdempotencyKeySchema.safeParse(params.request.headers.get("idempotency-key")).data ?? null,
        replayed: outcome.replayed === true,
        startedAt,
        completedAt: new Date(),
      }).catch((error) => {
        // History is operational evidence; losing a row must not fail the call.
        log.error("Capability execution could not be recorded", {
          appId: params.appId,
          capabilityId: params.capabilityId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      // Operational history must not extend a Query's response budget. The store
      // bounds this independent, best-effort write even for already-expired calls.
      if (params.kind === "queries") {
        try {
          await deadline.wait(() => recording);
        } catch {
          // The outcome is already known; return it while the bounded record finishes.
        }
      } else {
        await recording;
      }
    }
    return capabilityJsonResponse(outcome.body, outcome.status);
  } finally {
    deadline.clear();
  }
};

class MandateDispatchError extends Error {
  constructor(readonly status: 403 | 409) {
    super("Mandate does not authorize this capability invocation");
  }
}

export const createCapabilityRoutes = (dependencies: CapabilityRouteDependencies = {}) => {
  const requireReadScope = auth.requireOAuthScope("read", "admin");
  const requireWriteScope = auth.requireOAuthScope("write", "admin");
  const requireInvocationScope: MiddlewareHandler<AuthContext> = (c, next) =>
    (c.req.param("kind") === "actions" ? requireWriteScope : requireReadScope)(c, next);

  return new Hono<AuthContext>()
    .use("/capabilities/v1/*", noTransform())
    .use("/capabilities/v1/*", dependencies.authenticate ?? auth.requireRole("authenticated"))
    .use("/capabilities/v1/*", rejectReservedWorkloadCredential)
    .post(
      "/capabilities/v1/streams/:verb",
      describeRoute({
        tags: ["Capabilities"],
        summary: "Transfer or inspect one authorized binary stream",
        ...requiresAuth,
        description:
          "POST read/write/status/abort with x-cloud-stream-id. Write sends raw bytes; read returns raw bytes. Status and abort return the upload state. No automatic retries.",
        responses: {
          200: { description: "Binary content, write receipt, or transfer state" },
          403: { description: "Stream does not belong to this caller" },
          409: { description: "Transfer or contract changed" },
          410: { description: "Stream expired" },
        },
      }),
      async (c) => dispatchCapabilityStream(c.req.raw, auth.getAuthority(c), c.req.param("verb"), dependencies),
    )
    .get(
      "/capabilities/v1/catalog",
      describeRoute({
        tags: ["Capabilities"],
        summary: "List live app capabilities",
        description: "Returns the versioned capability manifests currently advertised by live app leases.",
        ...requiresAuth,
        responses: {
          200: jsonResponse(CapabilityCatalogSchema, "Live capability catalog"),
          401: jsonResponse(CapabilityErrorSchema, "Authentication required"),
          403: jsonResponse(CapabilityErrorSchema, "Insufficient OAuth scope"),
          503: jsonResponse(CapabilityErrorSchema, "Capability registry unavailable"),
        },
      }),
      requireReadScope,
      v("query", CapabilityCatalogQuerySchema),
      async (c) => {
        const query = c.req.valid("query");
        const messages = capabilityMessages(getLocale(c));
        try {
          return c.json(await loadCapabilityCatalogPage(query, dependencies, getLocale(c)));
        } catch (error) {
          log.warn("Capability catalog unavailable", { error: error instanceof Error ? error.message : String(error) });
          const unavailable = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.appUnavailable, messages.registryUnavailable, 503);
          return capabilityJsonResponse(unavailable.body, unavailable.status);
        }
      },
    )
    .post(
      "/capabilities/v1/commands/:appId/:capabilityId",
      describeRoute({
        tags: ["Capabilities"],
        summary: "Resolve an interactive Command link",
        ...requiresAuth,
        responses: {
          200: jsonResponse(CommandLinkSchema, "Command entry URL"),
          400: jsonResponse(CapabilityErrorSchema, "Invalid command input"),
          404: jsonResponse(CapabilityErrorSchema, "Command unavailable"),
          503: jsonResponse(CapabilityErrorSchema, "Route owner unavailable"),
        },
      }),
      requireReadScope,
      async (c) => {
        const body = await readBoundedJson(c.req.raw, CAPABILITY_MAX_REQUEST_BYTES);
        const request = body.ok ? CommandRequestSchema.safeParse(body.data) : null;
        if (!request?.success) return c.json({ code: "VALIDATION_FAILED", message: capabilityMessages(getLocale(c)).requestBodyJson }, 400);
        const appId = c.req.param("appId");
        const entry = await (dependencies.getCapability ?? getCapability)(appId);
        const command = entry?.manifest.commands.find((command) => command.localId === c.req.param("capabilityId"));
        if (!command)
          return c.json(
            {
              code: "CAPABILITY_NOT_FOUND",
              message: capabilityMessages(getLocale(c)).notFound({ kind: "Command", reference: `${appId}.${c.req.param("capabilityId")}` }),
            },
            404,
          );
        const apps = await (dependencies.listApps ?? listApps)();
        const pathname = new URL(command.path, "https://cloud.invalid").pathname;
        const owner = apps
          .flatMap((app) => app.routes.map((prefix) => ({ app, prefix })))
          .filter(({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`))
          .sort((a, b) => b.prefix.length - a.prefix.length)[0]?.app;
        if (owner?.id !== appId)
          return c.json({ code: "APP_UNAVAILABLE", message: capabilityMessages(getLocale(c)).appUnavailable({ appId }) }, 503);
        try {
          const appUrl = await (dependencies.appUrl ?? (() => settings.get<string>("app.url")))();
          return c.json(resolveCommandLink(appId, command, request.data.input, { returnTo: request.data.returnTo }, appUrl));
        } catch (error) {
          if (!(error instanceof z.ZodError) && !(error instanceof Error && error.message === "Command link is too large")) throw error;
          return c.json({ code: "VALIDATION_FAILED", message: capabilityMessages(getLocale(c)).inputSchemaMismatch }, 400);
        }
      },
    )
    .post(
      "/capabilities/v1/actions/:appId/:capabilityId/review",
      describeRoute({
        tags: ["Capabilities"],
        summary: "Review one live app Action",
        description: "Resolves the optional read-only human review for an Action with the caller credential.",
        ...requiresAuth,
        responses: {
          200: jsonResponse(z.unknown(), "Capability Action review"),
          400: jsonResponse(CapabilityErrorSchema, "Invalid request"),
          401: jsonResponse(CapabilityErrorSchema, "Authentication required"),
          403: jsonResponse(CapabilityErrorSchema, "Insufficient OAuth scope"),
          404: jsonResponse(CapabilityErrorSchema, "Capability review not found"),
          409: jsonResponse(CapabilityErrorSchema, "Schema changed"),
          499: jsonResponse(CapabilityErrorSchema, "Request cancelled"),
          500: jsonResponse(CapabilityErrorSchema, "Capability review failed"),
          502: jsonResponse(CapabilityErrorSchema, "Invalid app response"),
          503: jsonResponse(CapabilityErrorSchema, "App unavailable"),
          504: jsonResponse(CapabilityErrorSchema, "App deadline exceeded"),
        },
      }),
      requireReadScope,
      async (c) =>
        withCapabilityRequestTimeout(c, "review", async () => {
          const locale = getLocale(c);
          const messages = capabilityMessages(locale);
          const body = await readBoundedJson(c.req.raw, CAPABILITY_MAX_REQUEST_BYTES);
          if (!body.ok) {
            const message = body.reason === "too_large" ? messages.requestTooLarge : messages.requestBodyJson;
            const error = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.validationFailed, message, 400);
            return capabilityJsonResponse(error.body, error.status);
          }
          const request = CapabilityInvocationRequestSchema.safeParse(body.data);
          if (!request.success) {
            const error = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.validationFailed, messages.requestInputOnly, 400);
            return capabilityJsonResponse(error.body, error.status);
          }
          return dispatchCapability({
            request: c.req.raw,
            kind: "actions",
            review: true,
            origin: "http",
            appId: c.req.param("appId") ?? "",
            capabilityId: c.req.param("capabilityId") ?? "",
            input: request.data.input,
            authority: auth.getAuthority(c),
            locale,
            dependencies,
          });
        }),
    )
    .post(
      "/capabilities/v1/:kind{queries|actions}/:appId/:capabilityId",
      describeRoute({
        tags: ["Capabilities"],
        summary: "Invoke one live app capability",
        description: "Validates the live manifest and dispatches to the framework-owned app endpoint with the caller credential.",
        ...requiresAuth,
        responses: {
          200: jsonResponse(z.unknown(), "Capability result"),
          400: jsonResponse(CapabilityErrorSchema, "Invalid request"),
          401: jsonResponse(CapabilityErrorSchema, "Authentication required"),
          403: jsonResponse(CapabilityErrorSchema, "Insufficient OAuth scope"),
          404: jsonResponse(CapabilityErrorSchema, "Capability not found"),
          409: jsonResponse(CapabilityErrorSchema, "Schema changed"),
          429: jsonResponse(CapabilityErrorSchema, "Capability rate limited"),
          499: jsonResponse(CapabilityErrorSchema, "Request cancelled"),
          500: jsonResponse(CapabilityErrorSchema, "Capability execution failed"),
          502: jsonResponse(CapabilityErrorSchema, "Invalid app response"),
          503: jsonResponse(CapabilityErrorSchema, "App unavailable"),
          504: jsonResponse(CapabilityErrorSchema, "App deadline exceeded"),
        },
      }),
      requireInvocationScope,
      async (c) =>
        withCapabilityRequestTimeout(c, c.req.param("kind") === "queries" ? "query" : "action", async () => {
          const locale = getLocale(c);
          const messages = capabilityMessages(locale);
          const body = await readBoundedJson(c.req.raw, CAPABILITY_MAX_REQUEST_BYTES);
          if (!body.ok) {
            const message = body.reason === "too_large" ? messages.requestTooLarge : messages.requestBodyJson;
            const error = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.validationFailed, message, 400);
            return capabilityJsonResponse(error.body, error.status);
          }
          const request = CapabilityInvocationRequestSchema.safeParse(body.data);
          if (!request.success) {
            const error = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.validationFailed, messages.requestInputOnly, 400);
            return capabilityJsonResponse(error.body, error.status);
          }

          return dispatchCapability({
            request: c.req.raw,
            kind: c.req.param("kind") as "queries" | "actions",
            origin: "http",
            appId: c.req.param("appId") ?? "",
            capabilityId: c.req.param("capabilityId") ?? "",
            input: request.data.input,
            authority: auth.getAuthority(c),
            locale,
            dependencies,
          });
        }),
    );
};

export type CapabilityApiType = ReturnType<typeof createCapabilityRoutes>;
