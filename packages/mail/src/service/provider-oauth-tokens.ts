import { lazySync } from "@k2b/cloud";
import { decryptSecret, encryptSecret } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import type { MailOAuthProviderId, ProviderSecret } from "../contracts";
import { providerSecretSchema } from "../contracts";
import { postOAuthForm } from "./provider-oauth-http";
import { getConfiguredOAuthProvider } from "./provider-oauth-providers";

const REFRESH_LEAD_MS = 5 * 60_000;
const refreshMutex = lazySync((sync) =>
  sync.mutex({ id: "mail:provider-oauth-refresh", ttlMs: 60_000, retry: { maxAttempts: 81, delayMs: 250 } }),
);

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(65_536),
    refresh_token: z.string().min(1).max(65_536).optional(),
    expires_in: z.coerce
      .number()
      .int()
      .positive()
      .max(31 * 24 * 60 * 60),
    token_type: z.string().max(100).optional(),
    scope: z.string().max(16_384).optional(),
  })
  .passthrough();

export type OAuthTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
};

export const parseOAuthTokenResponse = (value: unknown, retainedRefreshToken: string | null = null, now = Date.now()): OAuthTokenSet => {
  const parsed = tokenResponseSchema.parse(value);
  if (parsed.token_type && parsed.token_type.toLowerCase() !== "bearer")
    throw new Error("OAuth provider returned an unsupported token type");
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? retainedRefreshToken,
    expiresAt: new Date(now + parsed.expires_in * 1_000).toISOString(),
  };
};

const clientForm = async (providerId: MailOAuthProviderId): Promise<{ form: URLSearchParams; tokenEndpoint: string }> => {
  const configured = await getConfiguredOAuthProvider(providerId);
  if (!configured) throw Object.assign(new Error("OAuth provider is not configured"), { code: "OAUTH_PROVIDER_UNAVAILABLE" });
  const form = new URLSearchParams({ client_id: configured.clientId });
  if (configured.clientSecret) form.set("client_secret", configured.clientSecret);
  return { form, tokenEndpoint: configured.declaration.tokenEndpoint };
};

export const exchangeOAuthAuthorizationCode = async (params: {
  providerId: MailOAuthProviderId;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  retainedRefreshToken?: string | null;
}): Promise<OAuthTokenSet> => {
  const { form, tokenEndpoint } = await clientForm(params.providerId);
  form.set("grant_type", "authorization_code");
  form.set("code", params.code);
  form.set("code_verifier", params.codeVerifier);
  form.set("redirect_uri", params.redirectUri);
  return parseOAuthTokenResponse(await postOAuthForm(tokenEndpoint, form), params.retainedRefreshToken ?? null);
};

const refreshOAuthTokenSet = async (params: { providerId: MailOAuthProviderId; refreshToken: string }): Promise<OAuthTokenSet> => {
  const { form, tokenEndpoint } = await clientForm(params.providerId);
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", params.refreshToken);
  return parseOAuthTokenResponse(await postOAuthForm(tokenEndpoint, form), params.refreshToken);
};

type ManagedOAuthRow = {
  encrypted_secret: string;
  secret_revision: number;
  oauth_provider_id: MailOAuthProviderId;
  oauth_token_revision: string | number;
  oauth_expires_at: Date | string | null;
};

const loadManagedOAuthRow = async (connectionId: string): Promise<ManagedOAuthRow | null> => {
  const [row] = await sql<ManagedOAuthRow[]>`
    SELECT encrypted_secret, secret_revision, oauth_provider_id, oauth_token_revision, oauth_expires_at
    FROM mail.provider_connections
    WHERE id = ${connectionId}::uuid
      AND status <> 'revoked'
      AND secret_kind = 'oauth2'
      AND oauth_provider_id IS NOT NULL
      AND encrypted_secret IS NOT NULL
  `;
  return row ?? null;
};

const needsRefresh = (value: Date | string | null): boolean => !value || new Date(value).getTime() <= Date.now() + REFRESH_LEAD_MS;

export const commitManagedOAuthRefresh = async (params: {
  connectionId: string;
  expectedSecretRevision: number;
  expectedOAuthTokenRevision: number;
  encryptedSecret: string;
  expiresAt: string;
}): Promise<boolean> => {
  const [updated] = await sql<{ id: string }[]>`
    UPDATE mail.provider_connections
    SET
      encrypted_secret = ${params.encryptedSecret},
      oauth_expires_at = ${params.expiresAt}::timestamptz,
      oauth_token_revision = oauth_token_revision + 1,
      last_error_code = NULL,
      last_error_message = NULL,
      updated_at = now()
    WHERE id = ${params.connectionId}::uuid
      AND status <> 'revoked'
      AND secret_revision = ${params.expectedSecretRevision}
      AND oauth_token_revision = ${params.expectedOAuthTokenRevision}
    RETURNING id
  `;
  return Boolean(updated);
};

export const refreshManagedOAuthConnection = async (connectionId: string): Promise<void> => {
  const locked = await refreshMutex().withLock({ resource: connectionId }, async () => {
    const row = await loadManagedOAuthRow(connectionId);
    if (!row || !needsRefresh(row.oauth_expires_at)) return;
    const secret = providerSecretSchema.parse(await decryptSecret<ProviderSecret>(row.encrypted_secret));
    if (secret.kind !== "oauth2" || !secret.refreshToken) {
      throw Object.assign(new Error("Provider OAuth credential requires reconnection"), { code: "CREDENTIAL_EXPIRED" });
    }
    const refreshed = await refreshOAuthTokenSet({ providerId: row.oauth_provider_id, refreshToken: secret.refreshToken });
    const nextSecret: ProviderSecret = {
      kind: "oauth2",
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? secret.refreshToken,
      expiresAt: refreshed.expiresAt,
    };
    const encrypted = await encryptSecret(nextSecret);
    const updated = await commitManagedOAuthRefresh({
      connectionId,
      expectedSecretRevision: row.secret_revision,
      expectedOAuthTokenRevision: Number(row.oauth_token_revision),
      encryptedSecret: encrypted,
      expiresAt: refreshed.expiresAt,
    });
    if (!updated) throw Object.assign(new Error("OAuth credential changed during refresh"), { code: "CREDENTIAL_REFRESH_SUPERSEDED" });
  });
  if (locked === null) throw Object.assign(new Error("OAuth credential refresh is already running"), { code: "CREDENTIAL_REFRESH_BUSY" });
};
