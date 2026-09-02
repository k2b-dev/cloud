import { toPgTextArray, toPgUuidArray } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import type { OAuthClient, OAuthScope } from "@/contracts";
import type { OAuthIssuanceMode } from "./token-authority";

type RefreshTokenStatus = "active" | "issuing" | "rotated" | "revoked" | "reused";
type RefreshTokenFamilyStatus = "active" | "revoked";

type DbRefreshTokenGrant = {
  id: string;
  family_id: string;
  secret_hash: string;
  status: RefreshTokenStatus;
  generation: number;
  expires_at: Date;
  client_id: string;
  user_id: string;
  scopes: string[];
  audiences: string[];
  resource: string | null;
  family_status: RefreshTokenFamilyStatus;
  family_expires_at: Date;
  authority_nonce: string | null;
  authority_reserved_at: Date | null;
  authority_issued_at: Date | null;
};

type ParsedRefreshToken = {
  tokenPrefix: string;
  secret: string;
};
type SqlRunner = typeof sql;

export type RefreshTokenRotationResult =
  | {
      ok: true;
      userId: string;
      client: OAuthClient;
      scopes: OAuthScope[];
      audiences: string[];
      resource: string | null;
      refreshToken: string;
      refreshTokenExpiresAt: string;
    }
  | {
      ok: false;
      error: "invalid_grant" | "invalid_scope" | "reuse_detected";
    };

/** A local policy rejection proven to happen before the Core authority was called. */
export class SafeRefreshIssuanceRejectionError extends Error {}

const TOKEN_PREFIX = "cld_rt";
const TOKEN_PATTERN = /^cld_rt_([0-9a-f]{24})_([0-9a-f]{64})$/i;
const REFRESH_TOKEN_LIFETIME_DAYS = 90;

export const shouldIssueRefreshToken = (scopes: OAuthScope[]): boolean => scopes.includes("offline_access");

const nowPlusDays = (days: number): Date => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

const randomHex = (bytes: number): string => {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
};

const generateTokenParts = (): { tokenPrefix: string; secret: string; token: string } => {
  const tokenPrefix = randomHex(12);
  const secret = randomHex(32);
  return { tokenPrefix, secret, token: `${TOKEN_PREFIX}_${tokenPrefix}_${secret}` };
};

const parseRefreshToken = (token: string): ParsedRefreshToken | null => {
  const match = token.match(TOKEN_PATTERN);
  if (!match) return null;
  return { tokenPrefix: match[1]!.toLowerCase(), secret: match[2]!.toLowerCase() };
};

const insertRefreshToken = async (params: {
  db: SqlRunner;
  familyId: string;
  generation: number;
  previousTokenId?: string | null;
  expiresAt: Date;
}): Promise<{ id: string; token: string; expiresAt: Date }> => {
  for (let i = 0; i < 5; i += 1) {
    const parts = generateTokenParts();
    const secretHash = await Bun.password.hash(parts.secret);
    const [row] = await params.db<{ id: string }[]>`
      INSERT INTO oauth.refresh_tokens (
        family_id,
        token_prefix,
        secret_hash,
        generation,
        previous_token_id,
        expires_at
      )
      VALUES (
        ${params.familyId}::uuid,
        ${parts.tokenPrefix},
        ${secretHash},
        ${params.generation},
        ${params.previousTokenId ?? null}::uuid,
        ${params.expiresAt}
      )
      ON CONFLICT (token_prefix) DO NOTHING
      RETURNING id
    `;
    if (row) return { id: row.id, token: parts.token, expiresAt: params.expiresAt };
  }
  throw new Error("Failed to generate unique refresh token prefix");
};

export const create = async (params: {
  userId: string;
  client: OAuthClient;
  scopes: OAuthScope[];
  audiences?: string[];
  resource?: string | null;
  label?: string | null;
}): Promise<{ refreshToken: string; refreshTokenExpiresAt: string; familyId: string }> => {
  const expiresAt = nowPlusDays(REFRESH_TOKEN_LIFETIME_DAYS);

  return sql.begin(async (tx) => {
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO oauth.refresh_token_families (
        client_id,
        user_id,
        scopes,
        audiences,
        resource,
        label,
        expires_at
      )
      VALUES (
        ${params.client.clientId},
        ${params.userId}::uuid,
        ${toPgTextArray(params.scopes)}::text[],
        ${toPgTextArray(params.audiences ?? params.client.audiences)}::text[],
        ${params.resource ?? null},
        ${params.label ?? null},
        ${expiresAt}
      )
      RETURNING id
    `;
    if (!family) throw new Error("Failed to create refresh token family");

    const token = await insertRefreshToken({
      db: tx,
      familyId: family.id,
      generation: 1,
      expiresAt,
    });

    return {
      familyId: family.id,
      refreshToken: token.token,
      refreshTokenExpiresAt: token.expiresAt.toISOString(),
    };
  });
};

const revokeFamily = async (familyId: string, reason: string): Promise<void> => {
  await sql`
    UPDATE oauth.refresh_token_families
    SET status = 'revoked',
      revoked_at = COALESCE(revoked_at, now()),
      revoked_reason = ${reason}
    WHERE id = ${familyId}::uuid
      AND status = 'active'
  `;
  await sql`
    UPDATE oauth.refresh_tokens
    SET status = 'revoked',
      revoked_at = COALESCE(revoked_at, now())
    WHERE family_id = ${familyId}::uuid
      AND status IN ('active', 'issuing')
  `;
};

export const rotate = async (
  refreshToken: string,
  client: OAuthClient,
  expectedAudience?: string,
  requestedScopes?: OAuthScope[],
  beforeRotation?: (grant: {
    userId: string;
    scopes: OAuthScope[];
    audiences: string[];
    resource: string | null;
    authorityGrant: { kind: "refresh_token"; tokenId: string; nonce: string };
  }) => Promise<OAuthIssuanceMode>,
): Promise<RefreshTokenRotationResult> => {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) return { ok: false, error: "invalid_grant" };

  const reserved = await sql.begin(async (tx) => {
    const [row] = await tx<DbRefreshTokenGrant[]>`
      SELECT
        rt.id,
        rt.family_id,
        rt.secret_hash,
        rt.status,
        rt.generation,
        rt.expires_at,
        f.client_id,
        f.user_id,
        f.scopes,
        f.audiences,
        f.resource,
        f.status AS family_status,
        f.expires_at AS family_expires_at,
        rt.authority_nonce,
        rt.authority_reserved_at,
        rt.authority_issued_at
      FROM oauth.refresh_tokens rt
      JOIN oauth.refresh_token_families f ON f.id = rt.family_id
      WHERE rt.token_prefix = ${parsed.tokenPrefix}
      FOR UPDATE OF rt, f
    `;
    if (!row) return { ok: false as const, error: "invalid_grant" as const };

    const valid = await Bun.password.verify(parsed.secret, row.secret_hash);
    if (!valid) return { ok: false as const, error: "invalid_grant" as const };
    if (row.client_id !== client.clientId) return { ok: false as const, error: "invalid_grant" as const };
    if (row.resource && expectedAudience !== row.resource) return { ok: false as const, error: "invalid_grant" as const };
    if (expectedAudience && !row.audiences.includes(expectedAudience)) return { ok: false as const, error: "invalid_grant" as const };
    if (row.status !== "active") {
      if (row.status === "rotated" || row.status === "issuing") {
        await tx`
          UPDATE oauth.refresh_tokens
          SET status = 'reused',
            used_at = COALESCE(used_at, now())
          WHERE id = ${row.id}::uuid
        `;
        await tx`
          UPDATE oauth.refresh_token_families
          SET status = 'revoked',
            revoked_at = COALESCE(revoked_at, now()),
            revoked_reason = 'refresh_token_reuse'
          WHERE id = ${row.family_id}::uuid
        `;
        await tx`
          UPDATE oauth.refresh_tokens
          SET status = 'revoked',
            revoked_at = COALESCE(revoked_at, now())
          WHERE family_id = ${row.family_id}::uuid
            AND status IN ('active', 'issuing')
        `;
        return { ok: false as const, error: "reuse_detected" as const };
      }
      return { ok: false as const, error: "invalid_grant" as const };
    }

    if (row.family_status !== "active" || row.expires_at <= new Date() || row.family_expires_at <= new Date()) {
      return { ok: false as const, error: "invalid_grant" as const };
    }
    if (requestedScopes?.some((scope) => !row.scopes.includes(scope))) {
      return { ok: false as const, error: "invalid_scope" as const };
    }
    const scopes = requestedScopes ?? (row.scopes as OAuthScope[]);
    const audiences = expectedAudience ? [expectedAudience] : row.audiences;
    const resource = row.resource ?? expectedAudience ?? null;
    const authorityNonce = crypto.randomUUID();
    await tx`
      UPDATE oauth.refresh_tokens
      SET status = 'issuing', authority_nonce = ${authorityNonce}::uuid, authority_reserved_at = now(),
        authority_scopes = ${toPgTextArray(scopes)}::text[], authority_audiences = ${toPgTextArray(audiences)}::text[],
        authority_resource = ${resource}
      WHERE id = ${row.id}::uuid AND status = 'active'
    `;
    return {
      ok: true as const,
      tokenId: row.id,
      familyId: row.family_id,
      generation: row.generation,
      familyExpiresAt: row.family_expires_at,
      userId: row.user_id,
      scopes,
      audiences,
      resource,
      authorityGrant: { kind: "refresh_token" as const, tokenId: row.id, nonce: authorityNonce },
    };
  });

  if (!reserved.ok) return reserved;

  try {
    await beforeRotation?.({
      userId: reserved.userId,
      scopes: reserved.scopes,
      audiences: reserved.audiences,
      resource: reserved.resource,
      authorityGrant: reserved.authorityGrant,
    });
  } catch (error) {
    if (error instanceof SafeRefreshIssuanceRejectionError) {
      const released = await sql<{ id: string }[]>`
        UPDATE oauth.refresh_tokens
        SET status = 'active', authority_nonce = NULL, authority_reserved_at = NULL,
          authority_scopes = NULL, authority_audiences = NULL, authority_resource = NULL
        WHERE id = ${reserved.tokenId}::uuid
          AND status = 'issuing'
          AND authority_nonce = ${reserved.authorityGrant.nonce}::uuid
          AND authority_issued_at IS NULL
        RETURNING id
      `;
      if (released.length === 1) throw error;
    }
    await revokeFamily(reserved.familyId, "authority_issuance_failed");
    throw error;
  }
  const finalized = await sql.begin(async (tx) => {
    const [family] = await tx<{ id: string }[]>`
      SELECT id
      FROM oauth.refresh_token_families
      WHERE id = ${reserved.familyId}::uuid
        AND status = 'active'
        AND expires_at > now()
      FOR UPDATE
    `;
    if (!family) return null;
    const [current] = await tx<{ id: string }[]>`
      SELECT id
      FROM oauth.refresh_tokens
      WHERE id = ${reserved.tokenId}::uuid
        AND status = 'issuing'
        AND authority_nonce = ${reserved.authorityGrant.nonce}::uuid
        AND authority_issued_at IS NOT NULL
      FOR UPDATE
    `;
    if (!current) return null;
    const next = await insertRefreshToken({
      db: tx,
      familyId: reserved.familyId,
      generation: reserved.generation + 1,
      previousTokenId: reserved.tokenId,
      expiresAt: reserved.familyExpiresAt,
    });
    const rotated = await tx<{ id: string }[]>`
      UPDATE oauth.refresh_tokens
      SET status = 'rotated', used_at = now(), rotated_at = now()
      WHERE id = ${reserved.tokenId}::uuid
        AND status = 'issuing'
        AND authority_nonce = ${reserved.authorityGrant.nonce}::uuid
      RETURNING id
    `;
    if (rotated.length !== 1) throw new Error("OAuth refresh reservation changed during finalization");
    const updatedFamily = await tx<{ id: string }[]>`
      UPDATE oauth.refresh_token_families
      SET scopes = ${toPgTextArray(reserved.scopes)}::text[], audiences = ${toPgTextArray(reserved.audiences)}::text[],
        resource = ${reserved.resource}, last_used_at = now()
      WHERE id = ${reserved.familyId}::uuid AND status = 'active'
      RETURNING id
    `;
    if (updatedFamily.length !== 1) throw new Error("OAuth refresh family changed during finalization");
    return next;
  });
  if (!finalized) {
    await revokeFamily(reserved.familyId, "authority_issuance_finalize_failed");
    throw new Error("OAuth refresh issuance could not be finalized");
  }

  return {
    ok: true,
    userId: reserved.userId,
    client,
    scopes: reserved.scopes,
    audiences: reserved.audiences,
    resource: reserved.resource,
    refreshToken: finalized.token,
    refreshTokenExpiresAt: finalized.expiresAt.toISOString(),
  };
};

export const revoke = async (refreshToken: string, clientId?: string): Promise<void> => {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) return;

  const [row] = await sql<{ id: string; family_id: string; secret_hash: string; client_id: string }[]>`
    SELECT rt.id, rt.family_id, rt.secret_hash, f.client_id
    FROM oauth.refresh_tokens rt
    JOIN oauth.refresh_token_families f ON f.id = rt.family_id
    WHERE rt.token_prefix = ${parsed.tokenPrefix}
  `;
  if (!row) return;
  if (clientId && row.client_id !== clientId) return;

  const valid = await Bun.password.verify(parsed.secret, row.secret_hash);
  if (!valid) return;

  await revokeFamily(row.family_id, "revoked");
};

/** Remove grants that can no longer authorize or detect a relevant replay. */
export const cleanup = async (): Promise<number> => {
  const stranded = await sql<{ family_id: string }[]>`
    UPDATE oauth.refresh_tokens
    SET status = 'revoked', revoked_at = COALESCE(revoked_at, now())
    WHERE status = 'issuing' AND authority_reserved_at < now() - INTERVAL '5 minutes'
    RETURNING family_id
  `;
  if (stranded.length > 0) {
    await sql`
      UPDATE oauth.refresh_token_families
      SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()), revoked_reason = 'authority_issuance_stranded'
      WHERE id = ANY(${toPgUuidArray(stranded.map((row) => row.family_id))}::uuid[]) AND status = 'active'
    `;
  }
  const result = await sql`
    DELETE FROM oauth.refresh_token_families
    WHERE expires_at < now()
      OR (status = 'revoked' AND revoked_at < now() - INTERVAL '1 day')
  `;
  return result.count;
};
