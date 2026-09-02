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
const SchemaHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
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

const InvocationPayloadSchema = z
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
    credential_id: BoundedIdentifierSchema.optional(),
    scopes: z
      .array(ScopeSchema)
      .max(100)
      .refine((scopes) => new Set(scopes).size === scopes.length, "Scopes must be unique"),
    op: OperationSchema,
    schema_hash: SchemaHashSchema.nullable(),
    ver: z.literal(CLOUD_INVOCATION_PROTOCOL_VERSION),
    request_id: BoundedIdentifierSchema.optional(),
    mandate_id: z.string().uuid().optional(),
    mandate_revision: z.number().int().positive().optional(),
    workload_type: BoundedIdentifierSchema.optional(),
    workload_id: BoundedIdentifierSchema.optional(),
    jti: z.string().uuid(),
    iat: z.number().int().nonnegative(),
    nbf: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict()
  .superRefine((claims, context) => {
    if (claims.exp - claims.iat !== CLOUD_INVOCATION_TOKEN_TTL_SECONDS || claims.nbf !== claims.iat) {
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
    if (claims.credential_kind === "session" && claims.scopes.length > 0) {
      context.addIssue({ code: "custom", message: "A session invocation cannot carry credential scopes" });
    }
    if (claims.credential_kind === "api_key" && !claims.credential_id) {
      context.addIssue({ code: "custom", message: "An API-key invocation requires credential provenance" });
    }

    const mandateFields = [claims.mandate_id, claims.mandate_revision, claims.workload_type, claims.workload_id];
    const mandateFieldCount = mandateFields.filter((value) => value !== undefined).length;
    if (claims.credential_kind === "mandate" ? mandateFieldCount !== mandateFields.length : mandateFieldCount !== 0) {
      context.addIssue({ code: "custom", message: "Mandate provenance is incomplete or unexpected" });
    }
  });

export type CloudInvocationClaims = z.infer<typeof InvocationPayloadSchema>;
export type InvocationAuthority = Pick<
  CloudInvocationClaims,
  | "sub"
  | "principal_type"
  | "access_subject_type"
  | "access_subject_id"
  | "delegated_user_id"
  | "credential_kind"
  | "credential_id"
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
  issuedAt?: Date;
  jti?: string;
  signer?: PreparedIdentitySigner;
  issuer?: string;
}): Promise<{ token: string; kid: string; claims: CloudInvocationClaims }> => {
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
    exp: issuedAtSeconds + CLOUD_INVOCATION_TOKEN_TTL_SECONDS,
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
    const schemaHash = z.union([SchemaHashSchema, z.null()]).parse(expected.schemaHash);
    const runtime = options.issuer && (options.key || options.jwksUrl) ? null : await getIdentityRuntimeConfig();
    const issuer = options.issuer ?? runtime!.issuer;
    const jwksUrl = options.jwksUrl ?? runtime?.invocationJwksUrl;
    const state = options.key || !jwksUrl ? null : remoteSet(jwksUrl);
    if (state && jwksUrl) remote = { url: jwksUrl, state };
    let key = options.key ?? state?.key;
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
    let verified: Awaited<ReturnType<typeof jwtVerify>>;
    try {
      verified = await verify(key);
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey) || !remote) throw error;
      const now = Date.now();
      if (now - remote.state.lastForcedRefreshAt < 30_000) throw error;
      remote.state.lastForcedRefreshAt = now;
      identityMetrics.increment("unknown_kid_refresh");
      key = createRemoteSet(remote.url);
      remote.state.key = key;
      verified = await verify(key);
    }
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
