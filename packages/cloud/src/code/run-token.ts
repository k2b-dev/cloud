import { createRemoteJWKSet, decodeProtectedHeader, type JWTVerifyGetKey, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { CLOUD_IDENTITY_ALGORITHM, IDENTITY_JWKS_MAX_AGE_SECONDS, IDENTITY_REFRESH_TIMEOUT_MS } from "../services/identity/constants";
import { type PreparedIdentitySigner, prepareIdentitySigner } from "../services/identity/key-ring";
import { getIdentityRuntimeConfig } from "../services/identity/runtime-config";

/** Distinct from invocation/access tokens; only Core's bridge accepts this audience/use. */
export const CODE_RUN_TOKEN_TYPE = "cloud-code-run+jwt";
/** Matches the maximum Administration > Code wall-clock budget, never extended by a heartbeat. */
export const CODE_RUN_TOKEN_MAX_SECONDS = 300;
export const CodeRunTokenClaimsSchema = z
  .object({
    ver: z.literal(1),
    token_use: z.literal("code_run"),
    iss: z.url(),
    aud: z.literal("cloud-code-bridge"),
    iat: z.number().int().nonnegative(),
    nbf: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    codeId: z.string().regex(/^c_[a-z0-9]{4,16}$/),
    versionId: z.uuid(),
    entrypoint: z.string().min(1).max(256),
    runId: z.uuid(),
    generation: z.number().int().positive().safe(),
    mandateId: z.uuid(),
    mandateRevision: z.number().int().positive().safe(),
    bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
/** C4/C13 wire contract: immutable attempt binding. The token grants nothing without runner app proof and live admission. */
export type CodeRunTokenClaims = z.infer<typeof CodeRunTokenClaimsSchema>;
export type CodeRunTokenInput = Pick<
  CodeRunTokenClaims,
  "codeId" | "versionId" | "entrypoint" | "runId" | "generation" | "mandateId" | "mandateRevision" | "bundleHash"
>;
export type CodeRunTokenVerifyOptions = { issuer?: string; key?: JWTVerifyGetKey; now?: Date };
const keys = new Map<string, JWTVerifyGetKey>();
/** Core issues once when leasing an attempt. deadlineAt is Unix milliseconds from the original run deadline. */
export async function signCodeRunToken(
  input: CodeRunTokenInput,
  options: { deadlineAt: number; issuer?: string; signer?: PreparedIdentitySigner; now?: Date },
): Promise<string> {
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const exp = Math.floor(options.deadlineAt / 1000);
  if (!Number.isSafeInteger(exp) || exp <= now || exp - now > CODE_RUN_TOKEN_MAX_SECONDS) throw new RangeError("Invalid Code run deadline");
  const claims = CodeRunTokenClaimsSchema.parse({
    ...input,
    ver: 1,
    token_use: "code_run",
    iss: options.issuer ?? (await getIdentityRuntimeConfig()).issuer,
    aud: "cloud-code-bridge",
    iat: now,
    nbf: now,
    exp,
  });
  const signer = options.signer ?? (await prepareIdentitySigner("invocation"));
  if (signer.signUntil.getTime() < exp * 1000) throw new Error("Signing key expires before the Code run token");
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: CLOUD_IDENTITY_ALGORITHM, typ: CODE_RUN_TOKEN_TYPE, kid: signer.kid })
    .sign(signer.key);
  if (Buffer.byteLength(token) > 4096) throw new Error("Code run token exceeds the runner protocol budget");
  return token;
}
/** Stateless on every Core replica via the existing invocation JWKS. Live generation, policy and mandate checks remain mandatory. */
export async function verifyCodeRunToken(token: string, options: CodeRunTokenVerifyOptions = {}): Promise<CodeRunTokenClaims | null> {
  if (Buffer.byteLength(token) > 4096) return null;
  try {
    const header = decodeProtectedHeader(token);
    if (
      Object.keys(header).sort().join(",") !== "alg,kid,typ" ||
      header.alg !== CLOUD_IDENTITY_ALGORITHM ||
      header.typ !== CODE_RUN_TOKEN_TYPE ||
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
    const verified = await jwtVerify(token, key, {
      algorithms: [CLOUD_IDENTITY_ALGORITHM],
      typ: CODE_RUN_TOKEN_TYPE,
      issuer: options.issuer ?? runtime!.issuer,
      audience: "cloud-code-bridge",
      currentDate: options.now,
    });
    const parsed = CodeRunTokenClaimsSchema.safeParse(verified.payload);
    if (!parsed.success) return null;
    const claims = parsed.data;
    return claims.nbf === claims.iat && claims.exp > claims.iat && claims.exp - claims.iat <= CODE_RUN_TOKEN_MAX_SECONDS ? claims : null;
  } catch {
    return null;
  }
}
