import { createRemoteJWKSet, decodeProtectedHeader, errors, type JWTVerifyGetKey, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import {
  CLOUD_IDENTITY_ALGORITHM,
  CLOUD_SESSION_AUDIENCE,
  CLOUD_SESSION_TOKEN_TYPE,
  IDENTITY_CLOCK_TOLERANCE_SECONDS,
  IDENTITY_JWKS_MAX_AGE_SECONDS,
  IDENTITY_MAX_COMPACT_TOKEN_BYTES,
} from "./constants";
import type { PreparedIdentitySigner } from "./key-ring";
import { prepareIdentitySigner } from "./key-ring";
import { identityMetrics } from "./metrics";
import { getIdentityRuntimeConfig } from "./runtime-config";

const SessionPayloadSchema = z
  .object({
    iss: z.string().url(),
    aud: z.literal(CLOUD_SESSION_AUDIENCE),
    token_use: z.literal("session"),
    sub: z.string().uuid(),
    sid: z.string().uuid(),
    auth_epoch: z.number().int().nonnegative(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

export type CloudSessionClaims = z.infer<typeof SessionPayloadSchema>;

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
  const names = Object.keys(header).sort();
  if (names.join(",") !== "alg,kid,typ") throw new Error("Cloud session JWT has an unsupported protected header");
  if (header.alg !== CLOUD_IDENTITY_ALGORITHM || header.typ !== CLOUD_SESSION_TOKEN_TYPE) {
    throw new Error("Cloud session JWT uses the wrong algorithm or token type");
  }
  if (typeof header.kid !== "string" || !/^[0-9a-f-]{36}$/.test(header.kid)) {
    throw new Error("Cloud session JWT has an invalid key id");
  }
};

export const isSessionJwtCandidate = (token: string): boolean => {
  if (new TextEncoder().encode(token).byteLength > IDENTITY_MAX_COMPACT_TOKEN_BYTES) return false;
  try {
    const header = decodeProtectedHeader(token);
    return header.typ === CLOUD_SESSION_TOKEN_TYPE;
  } catch {
    return false;
  }
};

export const signSessionToken = async (params: {
  userId: string;
  sid: string;
  authEpoch: number;
  issuedAt: Date;
  expiresAt: Date;
  signer?: PreparedIdentitySigner;
}): Promise<{ token: string; kid: string }> => {
  const { issuer } = await getIdentityRuntimeConfig();
  const signer = params.signer ?? (await prepareIdentitySigner("session"));
  if (params.expiresAt.getTime() <= params.issuedAt.getTime()) throw new Error("Cloud session expiry must follow issuance");
  try {
    const token = await new SignJWT({ token_use: "session", sid: params.sid, auth_epoch: params.authEpoch })
      .setProtectedHeader({ alg: CLOUD_IDENTITY_ALGORITHM, typ: CLOUD_SESSION_TOKEN_TYPE, kid: signer.kid })
      .setIssuer(issuer)
      .setAudience(CLOUD_SESSION_AUDIENCE)
      .setSubject(params.userId)
      .setIssuedAt(Math.floor(params.issuedAt.getTime() / 1_000))
      .setExpirationTime(Math.floor(params.expiresAt.getTime() / 1_000))
      .sign(signer.key);
    if (new TextEncoder().encode(token).byteLength > IDENTITY_MAX_COMPACT_TOKEN_BYTES) {
      throw new Error("Generated Cloud session JWT exceeds 4 KiB");
    }
    identityMetrics.increment("sign_success");
    return { token, kid: signer.kid };
  } catch (error) {
    identityMetrics.increment("sign_failure");
    throw error;
  }
};

export const verifySessionToken = async (
  token: string,
  options: { issuer?: string; key?: JWTVerifyGetKey; jwksUrl?: URL; now?: Date } = {},
): Promise<CloudSessionClaims | null> => {
  if (new TextEncoder().encode(token).byteLength > IDENTITY_MAX_COMPACT_TOKEN_BYTES) return null;
  let remote: { url: URL; state: RemoteSetState } | null = null;
  try {
    const runtime = options.issuer && (options.key || options.jwksUrl) ? null : await getIdentityRuntimeConfig();
    const issuer = options.issuer ?? runtime!.issuer;
    const jwksUrl = options.jwksUrl ?? runtime?.sessionJwksUrl;
    const state = options.key || !jwksUrl ? null : remoteSet(jwksUrl);
    if (state && jwksUrl) remote = { url: jwksUrl, state };
    let key = options.key ?? state?.key;
    if (!key) throw new Error("Cloud session verifier has no public key source");
    assertProtectedHeader(decodeProtectedHeader(token));
    const verify = (candidate: JWTVerifyGetKey) =>
      jwtVerify(token, candidate, {
        algorithms: [CLOUD_IDENTITY_ALGORITHM],
        audience: CLOUD_SESSION_AUDIENCE,
        issuer,
        typ: CLOUD_SESSION_TOKEN_TYPE,
        clockTolerance: IDENTITY_CLOCK_TOLERANCE_SECONDS,
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
      verified = await verify(key);
      remote.state.key = key;
    }
    const parsed = SessionPayloadSchema.safeParse(verified.payload);
    if (!parsed.success || parsed.data.exp <= parsed.data.iat) throw new Error("Cloud session JWT claims are invalid");
    identityMetrics.increment("verify_success");
    return parsed.data;
  } catch (error) {
    if (error instanceof errors.JWKSNoMatchingKey && !remote) identityMetrics.increment("unknown_kid_refresh");
    identityMetrics.increment("verify_failure");
    return null;
  }
};

export const clearSessionVerifierCachesForTest = (): void => {
  remoteSets.clear();
};
