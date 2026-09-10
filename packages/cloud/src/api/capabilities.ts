import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { readBoundedJson } from "../_internal/bounded-json";
import { resolveCapabilityManifestPresentation } from "../_internal/capabilities";
import { getCapability, listApps } from "../_internal/registry";
import { type CapabilityExecutionStatus, capabilityValueMeta, recordCapabilityExecution } from "../capabilities/executions";
import {
  CAPABILITY_FRAMEWORK_ERROR_CODES,
  CAPABILITY_MAX_CATALOG_BYTES,
  CAPABILITY_MAX_REQUEST_BYTES,
  CAPABILITY_MAX_RESULT_BYTES,
  CAPABILITY_ORIGIN_HEADER,
  CAPABILITY_PROTOCOL_VERSION,
  CapabilityActionReviewSchema,
  type CapabilityCatalog,
  CapabilityCatalogSchema,
  CapabilityErrorSchema,
  CapabilityIdempotencyKeySchema,
  type CapabilityOrigin,
  capabilityResultJsonSchema,
} from "../contracts/capabilities";
import type { AppRegistryEntry, CapabilityRegistryEntry } from "../contracts/registry";
import {
  type AuthContext,
  auth,
  getLocale,
  jsonResponse,
  LOCALE_HEADER,
  preferredLocale,
  type RequestAuthority,
  rejectReservedWorkloadCredential,
  requiresAuth,
  v,
} from "../server";
import { logger } from "../services";
import { invocationAuthorityFromRequest } from "../services/identity/invocation-authority";
import { capabilityInvocationOperation } from "../services/identity/invocation-operations";
import type { InvocationAuthority } from "../services/identity/invocation-token";
import { normalizeInvocationRequestId, signInvocationToken } from "../services/identity/invocation-token";
import { withActiveIdentitySigner } from "../services/identity/key-ring";
import { withMandateIssueAuthority } from "../services/mandates";
import { resolveAppPresentation } from "../shared/app-presentation";
import { capabilityMessages } from "../shared/capability-messages";

const log = logger("capabilities");
const QUERY_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 30_000;
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
};

export type CapabilityDispatchDependencies = Pick<
  CapabilityRouteDependencies,
  "getCapability" | "fetch" | "queryTimeoutMs" | "actionTimeoutMs" | "signInvocation" | "withActiveSigner" | "withMandateIssueAuthority"
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

const waitWithin = <T>(value: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
    value.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });

export type CapabilityDispatchParams = {
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
  dependencies?: CapabilityDispatchDependencies;
};

type CapabilityDispatchOutcome = { body: unknown; status: number };

/** Principal resolved while dispatching. A mandate only reveals it during issuance. */
type CapabilityDispatchObservation = {
  subject: { type: "user" | "service_account"; id: string } | null;
  destructive: boolean;
};

const runCapabilityDispatch = async (
  params: CapabilityDispatchParams,
  requestId: string,
  observed: CapabilityDispatchObservation,
): Promise<CapabilityDispatchOutcome> => {
  const messages = capabilityMessages(params.locale ?? preferredLocale(params.request.headers));
  const registryEntry = params.dependencies?.getCapability ?? getCapability;
  const fetchUpstream = params.dependencies?.fetch ?? globalThis.fetch;
  let entry: CapabilityRegistryEntry | null;
  try {
    entry = await registryEntry(params.appId);
  } catch (error) {
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
  const timeoutMs =
    params.kind === "queries" || params.review
      ? (params.dependencies?.queryTimeoutMs ?? QUERY_TIMEOUT_MS)
      : (params.dependencies?.actionTimeoutMs ?? ACTION_TIMEOUT_MS);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([params.request.signal, timeout]);
  let headers: Headers;
  try {
    headers = mandate
      ? await (async () => {
          const issued = await waitWithin(
            (params.dependencies?.withActiveSigner ?? withActiveIdentitySigner)(
              "invocation",
              (signer, db) =>
                (params.dependencies?.withMandateIssueAuthority ?? withMandateIssueAuthority)(
                  {
                    mandateId: mandate.mandateId,
                    expectedRevision: mandate.mandateRevision,
                    ownerAppId: mandate.ownerAppId,
                    targetAppId: params.appId,
                    operation: invocationOperation,
                    actionApproval: mandate.actionApproval ?? "none",
                    requestId,
                  },
                  async (mandateAuthority) => {
                    signal.throwIfAborted();
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
                ),
              { signal, timeoutMs },
            ),
            signal,
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
          const signed = await waitWithin(
            (params.dependencies?.withActiveSigner ?? withActiveIdentitySigner)(
              "invocation",
              (signer) =>
                (params.dependencies?.signInvocation ?? signInvocationToken)({
                  targetAppId: params.appId,
                  callingAppId: params.callingAppId ?? "core",
                  operation: invocationOperation,
                  schemaHash: operation.schemaHash,
                  authority: invocationAuthorityFromRequest(authority),
                  requestId,
                  signer,
                  issuer: signer.issuer,
                }),
              { signal, timeoutMs },
            ),
            signal,
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
    if (params.request.signal.aborted || timeout.aborted) {
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

  let response: Response;
  try {
    response = await fetchUpstream(
      `${entry.endpoint}/${params.kind}/${encodeURIComponent(params.capabilityId)}${params.review ? "/review" : ""}`,
      {
        method: "POST",
        headers,
        body: requestBody,
        signal,
      },
    );
  } catch (error) {
    log.warn("Capability app unavailable", {
      appId: params.appId,
      capabilityId: params.capabilityId,
      kind: params.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    if (actionWithoutRetrySafety) return outcomeUnknown();
    if (params.request.signal.aborted) {
      const cancelled = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.requestCancelled, messages.requestCancelled, 499, {
        retrySafe: params.kind === "queries" || ("idempotency" in operation && operation.idempotency === "required"),
      });
      return cancelled;
    }
    if (timeout.aborted) {
      const deadline = errorResponse(CAPABILITY_FRAMEWORK_ERROR_CODES.deadlineExceeded, messages.deadlineExceeded, 504, {
        retrySafe: params.kind === "queries" || ("idempotency" in operation && operation.idempotency === "required"),
      });
      return deadline;
    }
    const unavailable = errorResponse(
      CAPABILITY_FRAMEWORK_ERROR_CODES.appUnavailable,
      messages.appCouldNotServe({ appId: params.appId }),
      503,
      { retrySafe: params.kind === "queries" || ("idempotency" in operation && operation.idempotency === "required") },
    );
    return unavailable;
  }

  const upstreamBody = await readBoundedJson(response, CAPABILITY_MAX_RESULT_BYTES);
  if (!upstreamBody.ok) {
    if (actionWithoutRetrySafety) return outcomeUnknown();
    const code =
      upstreamBody.reason === "too_large"
        ? CAPABILITY_FRAMEWORK_ERROR_CODES.responseTooLarge
        : CAPABILITY_FRAMEWORK_ERROR_CODES.invalidAppResponse;
    const invalid = errorResponse(code, messages.invalidCapabilityJson({ appId: params.appId }), 502);
    return invalid;
  }

  if (!response.ok) {
    const parsed = CapabilityErrorSchema.safeParse(upstreamBody.data);
    if (parsed.success && response.status >= 400 && response.status <= 599) {
      return { body: parsed.data, status: response.status };
    }
    if (actionWithoutRetrySafety) return outcomeUnknown();
    const invalid = errorResponse("INVALID_APP_RESPONSE", messages.invalidCapabilityError({ appId: params.appId }), 502);
    return invalid;
  }

  const resultValidator = params.review
    ? CapabilityActionReviewSchema
    : schemaValidator(`${operation.schemaHash}:result`, capabilityResultJsonSchema(operation.dataSchema));
  const parsedResult = resultValidator?.safeParse(upstreamBody.data);
  const parsedReview = params.review ? CapabilityActionReviewSchema.safeParse(upstreamBody.data) : null;
  const reviewApprovalScopeIsValid =
    !params.review ||
    !("approval" in operation) ||
    !parsedReview?.success ||
    (operation.approval === "rememberable" ? parsedReview.data.approvalScope !== undefined : parsedReview.data.approvalScope === undefined);
  if (!resultValidator || !parsedResult?.success || !reviewApprovalScopeIsValid) {
    if (actionWithoutRetrySafety) return outcomeUnknown();
    const invalid = errorResponse("INVALID_APP_RESPONSE", messages.outsideResultSchema({ appId: params.appId }), 502);
    return invalid;
  }

  return { body: upstreamBody.data, status: 200 };
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
 * This is the single writer of `capabilities.executions`: one invocation
 * produces exactly one row, whatever its outcome. Action reviews are a
 * read-only preview and are not executions, so they are not recorded.
 */
export const dispatchCapability = async (params: CapabilityDispatchParams): Promise<Response> => {
  const requestId = normalizeInvocationRequestId(params.request.headers.get("x-request-id")) ?? crypto.randomUUID();
  const observed: CapabilityDispatchObservation = { subject: null, destructive: false };
  const startedAt = new Date();
  const outcome = await runCapabilityDispatch(params, requestId, observed);
  if (!params.review) {
    const actor = params.authority?.actor;
    const principal =
      actor?.kind === "user"
        ? ({ type: "user", id: actor.user.id } as const)
        : actor?.kind === "service_account"
          ? ({ type: "service_account", id: actor.serviceAccount.id } as const)
          : observed.subject;
    const accessSubject = params.authority?.accessSubject;
    const subject =
      accessSubject?.type === "user"
        ? ({ type: "user", id: accessSubject.userId } as const)
        : accessSubject?.type === "service_account"
          ? ({ type: "service_account", id: accessSubject.serviceAccountId } as const)
          : null;
    const errorCode = outcome.status >= 400 ? bodyErrorCode(outcome.body) : null;
    await recordCapabilityExecution({
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
  }
  return capabilityJsonResponse(outcome.body, outcome.status);
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
    .use("/capabilities/v1/*", dependencies.authenticate ?? auth.requireRole("authenticated"))
    .use("/capabilities/v1/*", rejectReservedWorkloadCredential)
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
      async (c) => {
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
      },
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
      async (c) => {
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
      },
    );
};

export type CapabilityApiType = ReturnType<typeof createCapabilityRoutes>;
