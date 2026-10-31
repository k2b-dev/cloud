import { createRemoteJWKSet, decodeProtectedHeader, type JWTVerifyGetKey, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { CodeAccessOperationsSchema, CodeAccessTargetSchema } from "../contracts/code-access";
import {
  CLOUD_IDENTITY_ALGORITHM,
  CLOUD_INVOCATION_TOKEN_TTL_SECONDS,
  IDENTITY_JWKS_MAX_AGE_SECONDS,
  IDENTITY_REFRESH_TIMEOUT_MS,
} from "../services/identity/constants";
import { type PreparedIdentitySigner, prepareIdentitySigner } from "../services/identity/key-ring";
import { getIdentityRuntimeConfig } from "../services/identity/runtime-config";

/** Core's access proofs use invocation-purpose RS256 keys and a distinct JWT type/use. */
export const CODE_ACCESS_PROOF_TYPE = "cloud-code-access+jwt";
export const CODE_ACCESS_PROOF_TTL_SECONDS = CLOUD_INVOCATION_TOKEN_TTL_SECONDS;
const appId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9-]*$/);
const base = z.object({
  ver: z.literal(1),
  iss: z.url(),
  aud: z.string().regex(/^app:[a-z][a-z0-9-]{0,79}$/),
  iat: z.number().int().nonnegative(),
  nbf: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
export const CodeAccessProofClaimsSchema = base
  .extend({
    token_use: z.literal("code_access"),
    codeId: z.string().min(1).max(200),
    versionId: z.string().min(1).max(200),
    activationId: z.uuid(),
    activatingPerson: z.uuid(),
    principal: z.uuid(),
    grantId: z.uuid(),
    target: CodeAccessTargetSchema,
    operations: CodeAccessOperationsSchema,
  })
  .strict();
/**
 * Stable C3a/C9 wire format. Core issues a fresh proof for each target in an activation.
 * Persist grantId with the activation BEFORE issuing: retries, including reissued proofs,
 * reuse it. A proof binds Code, immutable version, activation, person, account, target and
 * the complete operation set. It never replaces the person's current target authority.
 */
export type CodeAccessProofClaims = z.infer<typeof CodeAccessProofClaimsSchema>;
export type CodeAccessProofInput = Omit<CodeAccessProofClaims, "ver" | "iss" | "aud" | "iat" | "nbf" | "exp" | "token_use">;
/** Cleanup authority permits only removing grants of this one Code account at the receiving app. */
export const CodeAccessCleanupClaimsSchema = base.extend({ token_use: z.literal("code_access_cleanup"), principal: z.uuid() }).strict();
export type CodeAccessCleanupClaims = z.infer<typeof CodeAccessCleanupClaimsSchema>;
/** Core reconciles one account's existing grants without requiring fresh target-manager authority. */
export const CodeAccessListClaimsSchema = base.extend({ token_use: z.literal("code_access_list"), principal: z.uuid() }).strict();
export type CodeAccessListClaims = z.infer<typeof CodeAccessListClaimsSchema>;

type SignOptions = { issuer?: string; signer?: PreparedIdentitySigner; now?: Date };
export type CodeAccessVerifyOptions = { issuer?: string; key?: JWTVerifyGetKey; now?: Date };
const keys = new Map<string, JWTVerifyGetKey>();
const sign = async (targetAppId: string, payload: object, options: SignOptions) => {
  const issuer = options.issuer ?? (await getIdentityRuntimeConfig()).issuer;
  const signer = options.signer ?? (await prepareIdentitySigner("invocation"));
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (signer.signUntil.getTime() < (now + CODE_ACCESS_PROOF_TTL_SECONDS) * 1000)
    throw new Error("Signing key expires before the Code access proof");
  const claims = {
    ...payload,
    ver: 1,
    iss: issuer,
    aud: `app:${appId.parse(targetAppId)}`,
    iat: now,
    nbf: now,
    exp: now + CODE_ACCESS_PROOF_TTL_SECONDS,
  };
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: CLOUD_IDENTITY_ALGORITHM, typ: CODE_ACCESS_PROOF_TYPE, kid: signer.kid })
    .sign(signer.key);
  if (Buffer.byteLength(token) > 64 * 1024) throw new Error("Code access proof exceeds its byte budget");
  return token;
};
/** Core-only issuer. Target apps receive only the public invocation JWKS. */
export const signCodeAccessProof = async (targetAppId: string, input: CodeAccessProofInput, options: SignOptions = {}): Promise<string> => {
  const parsed = CodeAccessProofClaimsSchema.omit({
    ver: true,
    iss: true,
    aud: true,
    iat: true,
    nbf: true,
    exp: true,
    token_use: true,
  }).parse(input);
  return sign(targetAppId, { ...parsed, token_use: "code_access" }, options);
};
/** Core's durable cleanup worker reissues this short-lived authority for one account per app. */
export const signCodeAccessCleanup = (targetAppId: string, principal: string, options: SignOptions = {}): Promise<string> =>
  sign(targetAppId, { token_use: "code_access_cleanup", principal: z.uuid().parse(principal) }, options);

/** Core-only inspection authority, after checking the person's access to the owning Code. */
export const signCodeAccessList = (targetAppId: string, principal: string, options: SignOptions = {}): Promise<string> =>
  sign(targetAppId, { token_use: "code_access_list", principal: z.uuid().parse(principal) }, options);

const verify = async (token: string, targetAppId: string, options: CodeAccessVerifyOptions) => {
  if (Buffer.byteLength(token) > 64 * 1024) return null;
  try {
    const header = decodeProtectedHeader(token);
    if (
      Object.keys(header).sort().join(",") !== "alg,kid,typ" ||
      header.alg !== CLOUD_IDENTITY_ALGORITHM ||
      header.typ !== CODE_ACCESS_PROOF_TYPE ||
      !z.uuid().safeParse(header.kid).success
    )
      return null;
    const runtime = options.issuer && options.key ? null : await getIdentityRuntimeConfig();
    let key = options.key;
    if (!key && runtime) {
      const url = runtime.invocationJwksUrl.href;
      key = keys.get(url);
      if (!key) {
        key = createRemoteJWKSet(runtime.invocationJwksUrl, {
          cacheMaxAge: IDENTITY_JWKS_MAX_AGE_SECONDS * 1000,
          timeoutDuration: IDENTITY_REFRESH_TIMEOUT_MS,
        });
        keys.set(url, key);
      }
    }
    if (!key) return null;
    const { payload } = await jwtVerify(token, key, {
      algorithms: [CLOUD_IDENTITY_ALGORITHM],
      typ: CODE_ACCESS_PROOF_TYPE,
      issuer: options.issuer ?? runtime!.issuer,
      audience: `app:${appId.parse(targetAppId)}`,
      currentDate: options.now,
      clockTolerance: 0,
    });
    if (payload.exp !== Number(payload.iat) + CODE_ACCESS_PROOF_TTL_SECONDS || payload.nbf !== payload.iat) return null;
    return payload;
  } catch {
    return null;
  }
};
/** Verify signature, exact lifetime/audience/use and the complete target/operation binding. */
export const verifyCodeAccessProof = async (
  token: string,
  expected: { appId: string; target: z.infer<typeof CodeAccessTargetSchema>; operations: readonly string[]; activatingPerson: string },
  options: CodeAccessVerifyOptions = {},
): Promise<CodeAccessProofClaims | null> => {
  const parsed = CodeAccessProofClaimsSchema.safeParse(await verify(token, expected.appId, options));
  if (!parsed.success) return null;
  const claims = parsed.data;
  return claims.activatingPerson === expected.activatingPerson &&
    claims.target.type === expected.target.type &&
    claims.target.id === expected.target.id &&
    JSON.stringify([...claims.operations].sort()) === JSON.stringify([...expected.operations].sort())
    ? claims
    : null;
};
/** A cleanup token is not an activation proof and can never grant, list or execute Code. */
export const verifyCodeAccessCleanup = async (
  token: string,
  targetAppId: string,
  options: CodeAccessVerifyOptions = {},
): Promise<CodeAccessCleanupClaims | null> => {
  const parsed = CodeAccessCleanupClaimsSchema.safeParse(await verify(token, targetAppId, options));
  return parsed.success ? parsed.data : null;
};

/** Inspection authority lists only its bound account; it grants and removes nothing. */
export const verifyCodeAccessList = async (
  token: string,
  targetAppId: string,
  options: CodeAccessVerifyOptions = {},
): Promise<CodeAccessListClaims | null> => {
  const parsed = CodeAccessListClaimsSchema.safeParse(await verify(token, targetAppId, options));
  return parsed.success ? parsed.data : null;
};
