import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createRemoteJWKSet, decodeProtectedHeader, errors, type JWTVerifyGetKey, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import {
  CLOUD_IDENTITY_ALGORITHM,
  CLOUD_INVOCATION_PROTOCOL_VERSION,
  CLOUD_INVOCATION_TOKEN_TTL_SECONDS,
  CLOUD_INVOCATION_TOKEN_TYPE,
  IDENTITY_JWKS_MAX_AGE_SECONDS,
  IDENTITY_MAX_COMPACT_TOKEN_BYTES,
  INVOCATION_CLOCK_TOLERANCE_SECONDS,
} from "./constants";
import { authorityFromParentInvocation } from "./invocation-authority";
import { type PreparedIdentitySigner, prepareIdentitySigner } from "./key-ring";
import { identityMetrics } from "./metrics";
import { getIdentityRuntimeConfig } from "./runtime-config";

const AppIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9-]*$/);
const OperationSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z][a-z0-9:._-]*$/);
const SchemaHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
const ScopeSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9:._*-]+$/);
const BoundedIdentifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/);

/** Optional transport metadata must not prevent issuance of valid authority. */
export const normalizeInvocationRequestId = (value: unknown): string | undefined => {
  const parsed = BoundedIdentifierSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const InvocationPayloadBaseSchema = z
  .object({
    iss: z.string().url(),
    aud: z.string().regex(/^app:[a-z][a-z0-9-]{0,79}$/),
    token_use: z.literal("invocation"),
    sub: z.string().uuid(),
    principal_type: z.enum(["user", "service_account"]),
    access_subject_type: z.enum(["user", "service_account"]),
    access_subject_id: z.string().uuid(),
    delegated_user_id: z.string().uuid().optional(),
    act: z.object({ sub: z.string().regex(/^app:[a-z][a-z0-9-]{0,79}$/) }).strict(),
    credential_kind: z.enum(["session", "oauth", "api_key", "mandate"]),
    /** Only for an app session of the mobile app, which never acts as an administrator. */
    session_kind: z.literal("app").optional(),
    credential_id: BoundedIdentifierSchema.optional(),
    oauth_client_id: z.string().min(1).max(200).optional(),
    credential_expires_at: z.iso.datetime().optional(),
    scopes: z
      .array(ScopeSchema)
      .max(100)
      .refine((scopes) => new Set(scopes).size === scopes.length, "Scopes must be unique"),
    op: OperationSchema,
    schema_hash: SchemaHashSchema,
    ver: z.literal(CLOUD_INVOCATION_PROTOCOL_VERSION),
    request_id: BoundedIdentifierSchema.optional(),
    mandate_id: z.string().uuid().optional(),
    mandate_revision: z.number().int().positive().optional(),
    workload_type: BoundedIdentifierSchema.optional(),
    workload_id: BoundedIdentifierSchema.optional(),
    parent_invocation_id: z.uuid().optional(),
    jti: z.string().uuid(),
    iat: z.number().int().nonnegative(),
    nbf: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

const validateInvocationClaims = (claims: z.infer<typeof InvocationPayloadBaseSchema>, context: z.RefinementCtx, subjectProbe = false) => {
  if (
    (claims.parent_invocation_id
      ? claims.exp <= claims.iat ||
        claims.exp - claims.iat > CLOUD_INVOCATION_TOKEN_TTL_SECONDS ||
        !claims.op.startsWith("capability.query:")
      : claims.exp - claims.iat !== CLOUD_INVOCATION_TOKEN_TTL_SECONDS) ||
    claims.nbf !== claims.iat
  ) {
    context.addIssue({ code: "custom", message: "Invocation lifetime is invalid" });
  }

  if (claims.principal_type === "user") {
    if (claims.access_subject_type !== "user" || claims.access_subject_id !== claims.sub || claims.delegated_user_id !== undefined) {
      context.addIssue({ code: "custom", message: "User invocation authority is inconsistent" });
    }
    if (claims.credential_kind === "api_key") {
      context.addIssue({ code: "custom", message: "An API key must act through a service account" });
    }
  } else if (claims.delegated_user_id) {
    if (claims.access_subject_type !== "user" || claims.access_subject_id !== claims.delegated_user_id) {
      context.addIssue({ code: "custom", message: "Delegated invocation authority is inconsistent" });
    }
  } else if (claims.access_subject_type !== "service_account" || claims.access_subject_id !== claims.sub) {
    context.addIssue({ code: "custom", message: "Service-account invocation authority is inconsistent" });
  }
  if (claims.credential_kind === "session" && claims.principal_type !== "user") {
    context.addIssue({ code: "custom", message: "A session invocation must use a user principal" });
  }
  if (claims.session_kind && claims.credential_kind !== "session") {
    context.addIssue({ code: "custom", message: "Only a session invocation has a session kind" });
  }
  if (claims.credential_kind === "session" && claims.scopes.length > 0) {
    context.addIssue({ code: "custom", message: "A session invocation cannot carry credential scopes" });
  }
  if (claims.credential_kind === "api_key" && !claims.credential_id) {
    context.addIssue({ code: "custom", message: "An API-key invocation requires credential provenance" });
  }

  const mandateFields = [claims.mandate_id, claims.mandate_revision, claims.workload_type, claims.workload_id];
  const mandateFieldCount = mandateFields.filter((value) => value !== undefined).length;
  if (
    claims.credential_kind === "mandate"
      ? mandateFieldCount !== mandateFields.length && !(subjectProbe && mandateFieldCount === 0)
      : mandateFieldCount !== 0
  ) {
    context.addIssue({ code: "custom", message: "Mandate provenance is incomplete or unexpected" });
  }
};

const InvocationPayloadSchema = InvocationPayloadBaseSchema.superRefine((claims, context) => validateInvocationClaims(claims, context));
const AppAccessProbeSchema = InvocationPayloadBaseSchema.extend({
  token_use: z.literal("app_access_probe"),
  act: z.object({ sub: z.literal("app:core") }).strict(),
  op: z.literal("app-access.check"),
  schema_hash: z.null(),
  parent_invocation_id: z.never().optional(),
}).superRefine((claims, context) => validateInvocationClaims({ ...claims, token_use: "invocation" }, context, true));

export type CloudInvocationClaims = z.infer<typeof InvocationPayloadSchema>;
export type InvocationAuthority = Pick<
  CloudInvocationClaims,
  | "sub"
  | "principal_type"
  | "access_subject_type"
  | "access_subject_id"
  | "delegated_user_id"
  | "credential_kind"
  | "session_kind"
  | "credential_id"
  | "oauth_client_id"
  | "credential_expires_at"
  | "scopes"
  | "mandate_id"
  | "mandate_revision"
  | "workload_type"
  | "workload_id"
>;

type RemoteSetState = { key: JWTVerifyGetKey; lastForcedRefreshAt: number };
const remoteSets = new Map<string, RemoteSetState>();

const createRemoteSet = (url: URL): JWTVerifyGetKey =>
  createRemoteJWKSet(url, {
    cacheMaxAge: IDENTITY_JWKS_MAX_AGE_SECONDS * 1_000,
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
  });

const remoteSet = (url: URL): RemoteSetState => {
  const key = url.href;
  const existing = remoteSets.get(key);
  if (existing) return existing;
  const created = { key: createRemoteSet(url), lastForcedRefreshAt: 0 };
  remoteSets.set(key, created);
  return created;
};

const assertProtectedHeader = (header: ReturnType<typeof decodeProtectedHeader>): void => {
  if (Object.keys(header).sort().join(",") !== "alg,kid,typ") {
    throw new Error("Cloud invocation JWT has an unsupported protected header");
  }
  if (header.alg !== CLOUD_IDENTITY_ALGORITHM || header.typ !== CLOUD_INVOCATION_TOKEN_TYPE) {
    throw new Error("Cloud invocation JWT uses the wrong algorithm or token type");
  }
  if (typeof header.kid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(header.kid)) {
    throw new Error("Cloud invocation JWT has an invalid key id");
  }
};

export const isInvocationJwtCandidate = (token: string): boolean => {
  if (new TextEncoder().encode(token).byteLength > IDENTITY_MAX_COMPACT_TOKEN_BYTES) return false;
  try {
    return decodeProtectedHeader(token).typ === CLOUD_INVOCATION_TOKEN_TYPE;
  } catch {
    return false;
  }
};

export const signInvocationToken = async (params: {
  targetAppId: string;
  callingAppId: string;
  operation: string;
  schemaHash: string | null;
  authority: InvocationAuthority;
  requestId?: string;
  parent?: CloudInvocationClaims;
  expiresAt?: number;
  issuedAt?: Date;
  jti?: string;
  signer?: PreparedIdentitySigner;
  issuer?: string;
}): Promise<{ token: string; kid: string; claims: CloudInvocationClaims }> => {
  if (
    params.parent &&
    (params.parent.parent_invocation_id ||
      params.parent.aud !== `app:${params.callingAppId}` ||
      params.parent.aud === `app:${params.targetAppId}` ||
      !params.operation.startsWith("capability.query:") ||
      !isDeepStrictEqual(authorityFromParentInvocation(params.parent), params.authority))
  ) {
    throw new Error("Child invocation cannot widen or change its parent authority");
  }
  const issuer = params.issuer ?? (await getIdentityRuntimeConfig()).issuer;
  const signer = params.signer ?? (await prepareIdentitySigner("invocation"));
  const issuedAt = params.issuedAt ?? new Date();
  const issuedAtSeconds = Math.floor(issuedAt.getTime() / 1_000);
  const requestId = normalizeInvocationRequestId(params.requestId);
  const claims = InvocationPayloadSchema.parse({
    ...params.authority,
    iss: issuer,
    aud: `app:${params.targetAppId}`,
    token_use: "invocation",
    act: { sub: `app:${params.callingAppId}` },
    op: params.operation,
    schema_hash: params.schemaHash,
    ver: CLOUD_INVOCATION_PROTOCOL_VERSION,
    ...(requestId ? { request_id: requestId } : {}),
    jti: params.jti ?? crypto.randomUUID(),
    iat: issuedAtSeconds,
    nbf: issuedAtSeconds,
    ...(params.parent ? { parent_invocation_id: params.parent.jti } : {}),
    exp: Math.min(issuedAtSeconds + CLOUD_INVOCATION_TOKEN_TTL_SECONDS, params.parent?.exp ?? Infinity, params.expiresAt ?? Infinity),
  });

  try {
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: CLOUD_IDENTITY_ALGORITHM, typ: CLOUD_INVOCATION_TOKEN_TYPE, kid: signer.kid })
      .sign(signer.key);
    if (new TextEncoder().encode(token).byteLength > IDENTITY_MAX_COMPACT_TOKEN_BYTES) {
      throw new Error("Generated Cloud invocation JWT exceeds 4 KiB");
    }
    identityMetrics.increment("sign_success");
    return { token, kid: signer.kid, claims };
  } catch (error) {
    identityMetrics.increment("sign_failure");
    throw error;
  }
};

async function verifyWithKeyRefresh(
  verify: (key: JWTVerifyGetKey) => ReturnType<typeof jwtVerify>,
  key: JWTVerifyGetKey,
  remote: { url: URL; state: RemoteSetState } | null,
) {
  try {
    return await verify(key);
  } catch (error) {
    if (!(error instanceof errors.JWKSNoMatchingKey) || !remote) throw error;
    const now = Date.now();
    if (now - remote.state.lastForcedRefreshAt < 30_000) throw error;
    remote.state.lastForcedRefreshAt = now;
    identityMetrics.increment("unknown_kid_refresh");
    const refreshed = createRemoteSet(remote.url);
    const verified = await verify(refreshed);
    remote.state.key = refreshed;
    return verified;
  }
}

/** With deferSchemaBinding, the caller must compare schema_hash after resolving live authority. */
export const verifyInvocationToken = async (
  token: string,
  expected: { targetAppId: string; operation: string; schemaHash: string | null },
  options: { issuer?: string; key?: JWTVerifyGetKey; jwksUrl?: URL; now?: Date; deferSchemaBinding?: boolean } = {},
): Promise<CloudInvocationClaims | null> => {
  if (new TextEncoder().encode(token).byteLength > IDENTITY_MAX_COMPACT_TOKEN_BYTES) return null;
  let remote: { url: URL; state: RemoteSetState } | null = null;
  try {
    const targetAppId = AppIdSchema.parse(expected.targetAppId);
    const operation = OperationSchema.parse(expected.operation);
    const schemaHash = SchemaHashSchema.parse(expected.schemaHash);
    const runtime = options.issuer && (options.key || options.jwksUrl) ? null : await getIdentityRuntimeConfig();
    const issuer = options.issuer ?? runtime!.issuer;
    const jwksUrl = options.jwksUrl ?? runtime?.invocationJwksUrl;
    const state = options.key || !jwksUrl ? null : remoteSet(jwksUrl);
    if (state && jwksUrl) remote = { url: jwksUrl, state };
    const key = options.key ?? state?.key;
    if (!key) throw new Error("Cloud invocation verifier has no public key source");
    assertProtectedHeader(decodeProtectedHeader(token));
    const verify = (candidate: JWTVerifyGetKey) =>
      jwtVerify(token, candidate, {
        algorithms: [CLOUD_IDENTITY_ALGORITHM],
        audience: `app:${targetAppId}`,
        issuer,
        typ: CLOUD_INVOCATION_TOKEN_TYPE,
        clockTolerance: INVOCATION_CLOCK_TOLERANCE_SECONDS,
        currentDate: options.now,
      });
    const verified = await verifyWithKeyRefresh(verify, key, remote);
    const parsed = InvocationPayloadSchema.safeParse(verified.payload);
    if (!parsed.success || parsed.data.op !== operation || (!options.deferSchemaBinding && parsed.data.schema_hash !== schemaHash)) {
      throw new Error("Cloud invocation JWT claims do not match the target operation");
    }
    identityMetrics.increment("verify_success");
    return parsed.data;
  } catch (error) {
    if (error instanceof errors.JWKSNoMatchingKey && !remote) identityMetrics.increment("unknown_kid_refresh");
    identityMetrics.increment("verify_failure");
    return null;
  }
};

export const clearInvocationVerifierCachesForTest = (): void => {
  remoteSets.clear();
};

const AppEventInvocationClaimsSchema = z
  .object({
    iss: z.string().url(),
    aud: z.string(),
    token_use: z.literal("app_event_delivery"),
    act: z.literal("app:core"),
    op: z.literal("app-event.deliver"),
    subscription_id: z.string().min(1).max(400),
    event_id: z.uuid(),
    payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
    iat: z.number().int(),
    nbf: z.number().int(),
    exp: z.number().int(),
    jti: z.uuid(),
  })
  .strict();

export const appEventPayloadHash = (payload: unknown): string => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

/** Core-to-app invocation, bound to one subscription, event and exact request body. */
export const signAppEventInvocation = async (input: {
  appId: string;
  subscriptionId: string;
  eventId: string;
  payload: unknown;
  issuer?: string;
  signer?: PreparedIdentitySigner;
  now?: Date;
  jti?: string;
}) => {
  const issuer = input.issuer ?? (await getIdentityRuntimeConfig()).issuer;
  const signer = input.signer ?? (await prepareIdentitySigner("invocation"));
  const now = Math.floor((input.now?.getTime() ?? Date.now()) / 1_000);
  if (signer.signUntil.getTime() < (now + CLOUD_INVOCATION_TOKEN_TTL_SECONDS) * 1000)
    throw new Error("Invocation signing key expires before the delivery token");
  const claims = AppEventInvocationClaimsSchema.parse({
    iss: issuer,
    aud: `app:${AppIdSchema.parse(input.appId)}`,
    token_use: "app_event_delivery",
    act: "app:core",
    op: "app-event.deliver",
    subscription_id: input.subscriptionId,
    event_id: input.eventId,
    payload_hash: appEventPayloadHash(input.payload),
    iat: now,
    nbf: now,
    exp: now + CLOUD_INVOCATION_TOKEN_TTL_SECONDS,
    jti: input.jti ?? crypto.randomUUID(),
  });
  return new SignJWT(claims)
    .setProtectedHeader({ alg: CLOUD_IDENTITY_ALGORITHM, typ: CLOUD_INVOCATION_TOKEN_TYPE, kid: signer.kid })
    .sign(signer.key);
};

export const verifyAppEventInvocation = async (
  token: string,
  input: { appId: string; subscriptionId: string; eventId: string; payload: unknown },
  options: { issuer?: string; key?: JWTVerifyGetKey; jwksUrl?: URL; now?: Date } = {},
): Promise<boolean> => {
  if (new TextEncoder().encode(token).byteLength > IDENTITY_MAX_COMPACT_TOKEN_BYTES) return false;
  try {
    assertProtectedHeader(decodeProtectedHeader(token));
    const runtime = options.issuer && (options.key || options.jwksUrl) ? null : await getIdentityRuntimeConfig();
    const issuer = options.issuer ?? runtime!.issuer;
    const url = options.jwksUrl ?? runtime?.invocationJwksUrl;
    const state = options.key || !url ? null : remoteSet(url);
    const key = options.key ?? state?.key;
    if (!key) return false;
    const verify = (key: JWTVerifyGetKey) =>
      jwtVerify(token, key, {
        algorithms: [CLOUD_IDENTITY_ALGORITHM],
        audience: `app:${AppIdSchema.parse(input.appId)}`,
        issuer,
        typ: CLOUD_INVOCATION_TOKEN_TYPE,
        clockTolerance: INVOCATION_CLOCK_TOLERANCE_SECONDS,
        currentDate: options.now,
      });
    const result = await verifyWithKeyRefresh(verify, key, state && url ? { url, state } : null);
    const claims = AppEventInvocationClaimsSchema.parse(result.payload);
    return (
      claims.exp - claims.iat === CLOUD_INVOCATION_TOKEN_TTL_SECONDS &&
      claims.nbf === claims.iat &&
      claims.subscription_id === input.subscriptionId &&
      claims.event_id === input.eventId &&
      claims.payload_hash === appEventPayloadHash(input.payload)
    );
  } catch {
    return false;
  }
};

/** Core-only, target-bound existence proof. It cannot authorize an application operation. */
export const signAppAccessProbe = async (input: {
  appId: string;
  authority: InvocationAuthority;
  issuer?: string;
  signer?: PreparedIdentitySigner;
  now?: Date;
}) => {
  const issuer = input.issuer ?? (await getIdentityRuntimeConfig()).issuer;
  const signer = input.signer ?? (await prepareIdentitySigner("invocation"));
  const now = Math.floor((input.now?.getTime() ?? Date.now()) / 1_000);
  if (signer.signUntil.getTime() < (now + CLOUD_INVOCATION_TOKEN_TTL_SECONDS) * 1000)
    throw new Error("Invocation signing key expires before the app-access probe");
  const claims = AppAccessProbeSchema.parse({
    ...input.authority,
    iss: issuer,
    aud: `app:${AppIdSchema.parse(input.appId)}`,
    token_use: "app_access_probe",
    act: { sub: "app:core" },
    op: "app-access.check",
    schema_hash: null,
    ver: CLOUD_INVOCATION_PROTOCOL_VERSION,
    iat: now,
    nbf: now,
    exp: now + CLOUD_INVOCATION_TOKEN_TTL_SECONDS,
    jti: crypto.randomUUID(),
  });
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: CLOUD_IDENTITY_ALGORITHM, typ: CLOUD_INVOCATION_TOKEN_TYPE, kid: signer.kid })
    .sign(signer.key);
  if (new TextEncoder().encode(token).byteLength > IDENTITY_MAX_COMPACT_TOKEN_BYTES) throw new Error("App-access probe exceeds 4 KiB");
  return token;
};

export const verifyAppAccessProbe = async (
  token: string,
  appId: string,
  options: { issuer?: string; key?: JWTVerifyGetKey; jwksUrl?: URL; now?: Date } = {},
): Promise<z.infer<typeof AppAccessProbeSchema> | null> => {
  if (new TextEncoder().encode(token).byteLength > IDENTITY_MAX_COMPACT_TOKEN_BYTES) return null;
  try {
    assertProtectedHeader(decodeProtectedHeader(token));
    const runtime = options.issuer && (options.key || options.jwksUrl) ? null : await getIdentityRuntimeConfig();
    const issuer = options.issuer ?? runtime!.issuer;
    const url = options.jwksUrl ?? runtime?.invocationJwksUrl;
    const state = options.key || !url ? null : remoteSet(url);
    const key = options.key ?? state?.key;
    if (!key) return null;
    const verify = (key: JWTVerifyGetKey) =>
      jwtVerify(token, key, {
        algorithms: [CLOUD_IDENTITY_ALGORITHM],
        audience: `app:${AppIdSchema.parse(appId)}`,
        issuer,
        typ: CLOUD_INVOCATION_TOKEN_TYPE,
        clockTolerance: INVOCATION_CLOCK_TOLERANCE_SECONDS,
        currentDate: options.now,
      });
    const result = await verifyWithKeyRefresh(verify, key, state && url ? { url, state } : null);
    return AppAccessProbeSchema.parse(result.payload);
  } catch {
    return null;
  }
};

// A separate payload prevents app authority from ever entering the person/mandate resolver.
const AppQueryClaimsSchema = z
  .object({
    iss: z.string().url(),
    aud: z.string().regex(/^app:[a-z][a-z0-9-]{0,79}$/),
    token_use: z.literal("app_query"),
    sub: AppIdSchema,
    credential_id: z.uuid(),
    service_account_id: z.uuid(),
    op: OperationSchema.refine((value) => value.startsWith("capability.query:")),
    schema_hash: z.string().regex(/^[a-f0-9]{64}$/),
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    request_id: BoundedIdentifierSchema,
    jti: z.uuid(),
    iat: z.number().int(),
    nbf: z.number().int(),
    exp: z.number().int(),
  })
  .strict()
  .refine((claims) => claims.nbf === claims.iat && claims.exp - claims.iat === CLOUD_INVOCATION_TOKEN_TTL_SECONDS);

const AppCapabilityClaimsSchema = z
  .object({
    iss: z.string().url(),
    aud: z.string().regex(/^app:[a-z][a-z0-9-]{0,79}$/),
    token_use: z.literal("app_capability"),
    sub: AppIdSchema,
    key_id: z.uuid(),
    permission: z.string().min(1).max(100),
    op: OperationSchema.refine((value) => value.startsWith("capability.query:") || value.startsWith("capability.action:")),
    schema_hash: z.string().regex(/^[a-f0-9]{64}$/),
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    request_id: BoundedIdentifierSchema,
    jti: z.uuid(),
    iat: z.number().int(),
    nbf: z.number().int(),
    exp: z.number().int(),
  })
  .strict()
  .refine((claims) => claims.nbf === claims.iat && claims.exp - claims.iat === CLOUD_INVOCATION_TOKEN_TTL_SECONDS);

export const signAppQueryInvocation = async (input: {
  workload: import("./workload-auth").AuthenticatedWorkload;
  targetAppId: string;
  capabilityId: string;
  schemaHash: string;
  input: unknown;
  requestId: string;
  signer: PreparedIdentitySigner & { issuer: string };
}) => {
  const now = Math.floor(Date.now() / 1000);
  if (input.signer.signUntil.getTime() < (now + CLOUD_INVOCATION_TOKEN_TTL_SECONDS) * 1000)
    throw new Error("Signing key expires before the app query");
  const claims = AppQueryClaimsSchema.parse({
    iss: input.signer.issuer,
    aud: `app:${input.targetAppId}`,
    token_use: "app_query",
    sub: input.workload.appId,
    credential_id: input.workload.credentialId,
    service_account_id: input.workload.serviceAccountId,
    op: `capability.query:${input.capabilityId}`,
    schema_hash: input.schemaHash,
    input_hash: appEventPayloadHash(input.input),
    request_id: input.requestId,
    jti: crypto.randomUUID(),
    iat: now,
    nbf: now,
    exp: now + CLOUD_INVOCATION_TOKEN_TTL_SECONDS,
  });
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: CLOUD_IDENTITY_ALGORITHM, typ: CLOUD_INVOCATION_TOKEN_TYPE, kid: input.signer.kid })
    .sign(input.signer.key);
  if (Buffer.byteLength(token) > IDENTITY_MAX_COMPACT_TOKEN_BYTES) throw new Error("App query token exceeds its byte budget");
  return { token, claims };
};

export const verifyAppQueryInvocation = async (
  token: string,
  expected: { appId: string; capabilityId: string; schemaHash: string; input: unknown },
  options: { issuer?: string; key?: JWTVerifyGetKey; now?: Date } = {},
) => {
  if (Buffer.byteLength(token) > IDENTITY_MAX_COMPACT_TOKEN_BYTES) return null;
  try {
    assertProtectedHeader(decodeProtectedHeader(token));
  } catch {
    return null;
  }
  // Configuration and key-fetch failures must remain retryable, rather than look like invalid tokens.
  const runtime = options.issuer && options.key ? null : await getIdentityRuntimeConfig();
  try {
    const issuer = options.issuer ?? runtime!.issuer;
    const state = options.key ? null : remoteSet(runtime!.invocationJwksUrl);
    const key = options.key ?? state!.key;
    const verified = await verifyWithKeyRefresh(
      (candidate) =>
        jwtVerify(token, candidate, {
          algorithms: [CLOUD_IDENTITY_ALGORITHM],
          issuer,
          audience: `app:${expected.appId}`,
          typ: CLOUD_INVOCATION_TOKEN_TYPE,
          clockTolerance: INVOCATION_CLOCK_TOLERANCE_SECONDS,
          currentDate: options.now,
        }),
      key,
      state ? { url: runtime!.invocationJwksUrl, state } : null,
    );
    const claims = AppQueryClaimsSchema.parse(verified.payload);
    if (
      claims.op !== `capability.query:${expected.capabilityId}` ||
      claims.schema_hash !== expected.schemaHash ||
      claims.input_hash !== appEventPayloadHash(expected.input)
    )
      return null;
    return claims;
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      error instanceof errors.JWTExpired ||
      error instanceof errors.JWTClaimValidationFailed ||
      error instanceof errors.JWTInvalid ||
      error instanceof errors.JWSInvalid ||
      error instanceof errors.JWSSignatureVerificationFailed ||
      error instanceof errors.JWKSNoMatchingKey ||
      error instanceof errors.JOSENotSupported
    )
      return null;
    throw error;
  }
};

export const signAppCapabilityInvocation = async (input: {
  app: { appId: string; keyId: string };
  kind: "query" | "action";
  permission: string;
  targetAppId: string;
  capabilityId: string;
  schemaHash: string;
  input: unknown;
  requestId: string;
  signer: PreparedIdentitySigner & { issuer: string };
}) => {
  const now = Math.floor(Date.now() / 1000);
  if (input.signer.signUntil.getTime() < (now + CLOUD_INVOCATION_TOKEN_TTL_SECONDS) * 1000)
    throw new Error("Signing key expires before the app capability invocation");
  const claims = AppCapabilityClaimsSchema.parse({
    iss: input.signer.issuer,
    aud: `app:${input.targetAppId}`,
    token_use: "app_capability",
    sub: input.app.appId,
    key_id: input.app.keyId,
    permission: input.permission,
    op: `capability.${input.kind}:${input.capabilityId}`,
    schema_hash: input.schemaHash,
    input_hash: appEventPayloadHash(input.input),
    request_id: input.requestId,
    jti: crypto.randomUUID(),
    iat: now,
    nbf: now,
    exp: now + CLOUD_INVOCATION_TOKEN_TTL_SECONDS,
  });
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: CLOUD_IDENTITY_ALGORITHM, typ: CLOUD_INVOCATION_TOKEN_TYPE, kid: input.signer.kid })
    .sign(input.signer.key);
  if (Buffer.byteLength(token) > IDENTITY_MAX_COMPACT_TOKEN_BYTES) throw new Error("App capability token exceeds its byte budget");
  return { token, claims };
};

export const verifyAppCapabilityInvocation = async (
  token: string,
  expected: { appId: string; kind: "query" | "action"; capabilityId: string; schemaHash: string; input: unknown; permission: string },
  options: { issuer?: string; key?: JWTVerifyGetKey; now?: Date } = {},
) => {
  if (Buffer.byteLength(token) > IDENTITY_MAX_COMPACT_TOKEN_BYTES) return null;
  try {
    assertProtectedHeader(decodeProtectedHeader(token));
  } catch {
    return null;
  }
  // Configuration and key-fetch failures must remain retryable, rather than look like invalid tokens.
  const runtime = options.issuer && options.key ? null : await getIdentityRuntimeConfig();
  try {
    const issuer = options.issuer ?? runtime!.issuer;
    const state = options.key ? null : remoteSet(runtime!.invocationJwksUrl);
    const key = options.key ?? state!.key;
    const verified = await verifyWithKeyRefresh(
      (candidate) =>
        jwtVerify(token, candidate, {
          algorithms: [CLOUD_IDENTITY_ALGORITHM],
          issuer,
          audience: `app:${expected.appId}`,
          typ: CLOUD_INVOCATION_TOKEN_TYPE,
          clockTolerance: INVOCATION_CLOCK_TOLERANCE_SECONDS,
          currentDate: options.now,
        }),
      key,
      state ? { url: runtime!.invocationJwksUrl, state } : null,
    );
    const claims = AppCapabilityClaimsSchema.parse(verified.payload);
    if (
      claims.permission !== expected.permission ||
      claims.op !== `capability.${expected.kind}:${expected.capabilityId}` ||
      claims.schema_hash !== expected.schemaHash ||
      claims.input_hash !== appEventPayloadHash(expected.input)
    )
      return null;
    return claims;
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      error instanceof errors.JWTExpired ||
      error instanceof errors.JWTClaimValidationFailed ||
      error instanceof errors.JWTInvalid ||
      error instanceof errors.JWSInvalid ||
      error instanceof errors.JWSSignatureVerificationFailed ||
      error instanceof errors.JWKSNoMatchingKey ||
      error instanceof errors.JOSENotSupported
    )
      return null;
    throw error;
  }
};

const MigrationProbeClaims = z
  .object({
    iss: z.string().url(),
    aud: z.string(),
    token_use: z.literal("app_migration_probe"),
    key_id: z.uuid(),
    oauth: z.boolean(),
    jti: z.uuid(),
    iat: z.number().int(),
    nbf: z.number().int(),
    exp: z.number().int(),
  })
  .strict();
/** Core's short-lived instruction to test one deployed key; carries no person or domain authority. */
export const signMigrationProbe = async (input: {
  appId: string;
  keyId: string;
  oauth: boolean;
  nonce: string;
  issuer?: string;
  signer?: PreparedIdentitySigner;
  now?: Date;
}) => {
  const issuer = input.issuer ?? (await getIdentityRuntimeConfig()).issuer;
  const signer = input.signer ?? (await prepareIdentitySigner("invocation"));
  const now = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);
  if (signer.signUntil.getTime() < (now + CLOUD_INVOCATION_TOKEN_TTL_SECONDS) * 1000)
    throw new Error("Invocation signing key expires before the migration probe");
  const claims = MigrationProbeClaims.parse({
    iss: issuer,
    aud: `app:${AppIdSchema.parse(input.appId)}`,
    token_use: "app_migration_probe",
    key_id: input.keyId,
    oauth: input.oauth,
    jti: input.nonce,
    iat: now,
    nbf: now,
    exp: now + CLOUD_INVOCATION_TOKEN_TTL_SECONDS,
  });
  return new SignJWT(claims)
    .setProtectedHeader({ alg: CLOUD_IDENTITY_ALGORITHM, typ: CLOUD_INVOCATION_TOKEN_TYPE, kid: signer.kid })
    .sign(signer.key);
};
export const verifyMigrationProbe = async (
  token: string,
  appId: string,
  options: { issuer?: string; key?: JWTVerifyGetKey; now?: Date } = {},
) => {
  if (new TextEncoder().encode(token).byteLength > IDENTITY_MAX_COMPACT_TOKEN_BYTES) return null;
  try {
    assertProtectedHeader(decodeProtectedHeader(token));
    const runtime = options.issuer && options.key ? null : await getIdentityRuntimeConfig();
    const url = runtime?.invocationJwksUrl;
    const state = options.key || !url ? null : remoteSet(url);
    const key = options.key ?? state?.key;
    if (!key) return null;
    const verify = (key: JWTVerifyGetKey) =>
      jwtVerify(token, key, {
        algorithms: [CLOUD_IDENTITY_ALGORITHM],
        audience: `app:${AppIdSchema.parse(appId)}`,
        issuer: options.issuer ?? runtime!.issuer,
        typ: CLOUD_INVOCATION_TOKEN_TYPE,
        clockTolerance: INVOCATION_CLOCK_TOLERANCE_SECONDS,
        currentDate: options.now,
      });
    const result = await verifyWithKeyRefresh(verify, key, state && url ? { url, state } : null);
    const claims = MigrationProbeClaims.parse(result.payload);
    return claims.exp - claims.iat === CLOUD_INVOCATION_TOKEN_TTL_SECONDS && claims.nbf === claims.iat ? claims : null;
  } catch {
    return null;
  }
};
