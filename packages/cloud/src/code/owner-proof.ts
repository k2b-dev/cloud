import { createRemoteJWKSet, decodeProtectedHeader, type JWTVerifyGetKey, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import {
  CLOUD_IDENTITY_ALGORITHM,
  CLOUD_INVOCATION_TOKEN_TTL_SECONDS,
  IDENTITY_JWKS_MAX_AGE_SECONDS,
  IDENTITY_REFRESH_TIMEOUT_MS,
  INVOCATION_CLOCK_TOLERANCE_SECONDS,
} from "../services/identity/constants";
import { type PreparedIdentitySigner, prepareIdentitySigner } from "../services/identity/key-ring";
import { getIdentityRuntimeConfig } from "../services/identity/runtime-config";

/** Core's owner reads use invocation-purpose RS256 keys and a distinct JWT type/use. */
export const CODE_OWNER_READ_TYPE = "cloud-code-owner+jwt";
export const CODE_OWNER_READ_TTL_SECONDS = CLOUD_INVOCATION_TOKEN_TTL_SECONDS;
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
/** Core reads only the title of the resource that owns this exact active Code account. */
export const CodeOwnerReadClaimsSchema = base.extend({ token_use: z.literal("code_owner_read"), principal: z.uuid() }).strict();
export type CodeOwnerReadClaims = z.infer<typeof CodeOwnerReadClaimsSchema>;

type SignOptions = { issuer?: string; signer?: PreparedIdentitySigner; now?: Date };
export type CodeOwnerVerifyOptions = { issuer?: string; key?: JWTVerifyGetKey; now?: Date };
const keys = new Map<string, JWTVerifyGetKey>();
const sign = async (targetAppId: string, payload: object, options: SignOptions) => {
  const issuer = options.issuer ?? (await getIdentityRuntimeConfig()).issuer;
  const signer = options.signer ?? (await prepareIdentitySigner("invocation"));
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (signer.signUntil.getTime() < (now + CODE_OWNER_READ_TTL_SECONDS) * 1000)
    throw new Error("Signing key expires before the Code owner read");
  const claims = {
    ...payload,
    ver: 1,
    iss: issuer,
    aud: `app:${appId.parse(targetAppId)}`,
    iat: now,
    nbf: now,
    exp: now + CODE_OWNER_READ_TTL_SECONDS,
  };
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: CLOUD_IDENTITY_ALGORITHM, typ: CODE_OWNER_READ_TYPE, kid: signer.kid })
    .sign(signer.key);
  if (Buffer.byteLength(token) > 64 * 1024) throw new Error("Code owner read exceeds its byte budget");
  return token;
};
/** The owning Code account is checked again by the resource's read-only owner projection. */
export const signCodeOwnerRead = (targetAppId: string, principal: string, options: SignOptions = {}): Promise<string> =>
  sign(targetAppId, { token_use: "code_owner_read", principal: z.uuid().parse(principal) }, options);

const verify = async (token: string, targetAppId: string, options: CodeOwnerVerifyOptions) => {
  if (Buffer.byteLength(token) > 64 * 1024) return null;
  try {
    const header = decodeProtectedHeader(token);
    if (
      Object.keys(header).sort().join(",") !== "alg,kid,typ" ||
      header.alg !== CLOUD_IDENTITY_ALGORITHM ||
      header.typ !== CODE_OWNER_READ_TYPE ||
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
      typ: CODE_OWNER_READ_TYPE,
      issuer: options.issuer ?? runtime!.issuer,
      audience: `app:${appId.parse(targetAppId)}`,
      currentDate: options.now,
      clockTolerance: INVOCATION_CLOCK_TOLERANCE_SECONDS,
    });
    if (payload.exp !== Number(payload.iat) + CODE_OWNER_READ_TTL_SECONDS || payload.nbf !== payload.iat) return null;
    return payload;
  } catch {
    return null;
  }
};
/** Verify exact audience, purpose and lifetime; this authority has no grant operations. */
export const verifyCodeOwnerRead = async (
  token: string,
  targetAppId: string,
  options: CodeOwnerVerifyOptions = {},
): Promise<CodeOwnerReadClaims | null> => {
  const parsed = CodeOwnerReadClaimsSchema.safeParse(await verify(token, targetAppId, options));
  return parsed.success ? parsed.data : null;
};
