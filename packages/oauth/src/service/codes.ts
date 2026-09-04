import { toPgTextArray } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import type { OAuthClient, OAuthScope } from "@/contracts";
import * as clients from "./clients";

// ==========================
// OAuth Authorization Codes Service
// ==========================

type DbCode = {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scopes: string[];
  audiences: string[];
  resource: string | null;
  nonce: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  expires_at: Date;
  used: boolean;
};

const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/**
 * Create an authorization code
 */
export const create = async (params: {
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: OAuthScope[];
  resource?: string;
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256";
  db?: typeof sql;
}): Promise<string> => {
  const { clientId, userId, redirectUri, scopes, resource, nonce, codeChallenge, codeChallengeMethod, db = sql } = params;

  const [row] = await db<{ code: string }[]>`
    INSERT INTO oauth.codes (client_id, user_id, redirect_uri, scopes, audiences, resource, nonce, code_challenge, code_challenge_method)
    SELECT
      client.client_id,
      ${userId}::uuid,
      ${redirectUri},
      ${toPgTextArray(scopes)}::text[],
      CASE
        WHEN ${resource ?? null}::text IS NOT NULL THEN ARRAY[${resource ?? null}::text]
        ELSE ARRAY(
          SELECT audience
          FROM unnest(ARRAY['cloud', client.client_id]::text[] || client.audiences) WITH ORDINALITY AS value(audience, position)
          GROUP BY audience
          ORDER BY min(position)
        )
      END,
      ${resource ?? null},
      ${nonce ?? null},
      ${codeChallenge ?? null},
      ${codeChallengeMethod ?? null}
    FROM oauth.clients client
    WHERE client.client_id = ${clientId}
    RETURNING code
  `;

  if (!row) throw new Error("OAuth client no longer exists");
  return row.code;
};

/**
 * Consume (use) an authorization code and return user/client info
 * Returns null if code is invalid, expired, already used, or PKCE validation fails
 */
export const consume = async (params: {
  code: string;
  clientId: string;
  client?: OAuthClient;
  redirectUri: string;
  resource?: string;
  codeVerifier?: string;
}): Promise<{
  userId: string;
  client: OAuthClient;
  scopes: OAuthScope[];
  audiences: string[];
  resource: string | null;
  nonce: string | null;
  authorityGrant: { kind: "authorization_code"; code: string; nonce: string };
} | null> => {
  const { code, clientId, redirectUri, resource, codeVerifier } = params;

  // Get and validate code
  const [row] = await sql<DbCode[]>`
    SELECT code, client_id, user_id, redirect_uri, scopes, audiences, resource, nonce, code_challenge, code_challenge_method, expires_at, used
    FROM oauth.codes
    WHERE code = ${code}
  `;

  if (!row) return null;

  // Check if already used
  if (row.used) return null;

  // Check expiration
  if (row.expires_at < new Date()) return null;

  // Validate client_id matches
  if (row.client_id !== clientId) return null;

  // Validate redirect_uri matches
  if (row.redirect_uri !== redirectUri) return null;
  if (row.resource !== (resource ?? null)) return null;

  // PKCE validation
  if (row.code_challenge) {
    if (!codeVerifier || !PKCE_VERIFIER_PATTERN.test(codeVerifier)) return null;

    if (row.code_challenge_method !== "S256") return null;
    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    const hash = await crypto.subtle.digest("SHA-256", data);
    const computedChallenge = base64UrlEncode(new Uint8Array(hash));

    if (computedChallenge !== row.code_challenge) return null;
  }

  // Mark as used atomically so concurrent token exchanges cannot consume the same code twice.
  const authorityNonce = crypto.randomUUID();
  const [usedRow] = await sql<{ code: string }[]>`
    UPDATE oauth.codes
    SET used = true, authority_nonce = ${authorityNonce}::uuid
    WHERE code = ${code}
      AND used = false
      AND expires_at >= now()
    RETURNING code
  `;
  if (!usedRow) return null;

  // Get client
  const client = params.client ?? (await clients.getByClientId({ clientId }));
  if (!client) return null;

  return {
    userId: row.user_id,
    client,
    scopes: row.scopes as OAuthScope[],
    audiences: row.audiences,
    resource: row.resource,
    nonce: row.nonce,
    authorityGrant: { kind: "authorization_code", code, nonce: authorityNonce },
  };
};

/**
 * Cleanup expired and used codes
 */
export const cleanup = async (): Promise<number> => {
  const result = await sql`
    DELETE FROM oauth.codes
    WHERE expires_at < now() OR (used = true AND authority_issued_at IS NOT NULL)
  `;
  return result.count;
};

// ==========================
// Helpers
// ==========================

/**
 * Encodes bytes into base64url format required by PKCE challenge checks.
 */
function base64UrlEncode(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
