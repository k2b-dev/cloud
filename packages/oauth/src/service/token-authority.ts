import { env } from "@k2b/cloud/config";
import type { OAuthAuthorityStatement, OAuthDeviceApprovalRequest, OAuthIssuerNewAccessNotice } from "@k2b/cloud/contracts";
import { sendAppRequest } from "@k2b/cloud/services/identity";
import { z } from "zod";

export type OAuthUserGrantReference =
  | { kind: "authorization_code"; code: string; familyId?: string }
  | { kind: "refresh_token"; tokenId: string }
  | { kind: "device_code"; deviceAuthorizationId: string; familyId?: string };

const AuthorityResponseSchema = z.object({
  tokens: z.array(z.string().min(1).max(16_384)).min(1).max(2),
});

type AuthorityFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A complete error response is safe to release; timeouts and malformed success responses are uncertain. */
export class OAuthAuthorityRejectedError extends Error {
  constructor(readonly status: number) {
    super(`Core OAuth issuance failed with status ${status}`);
  }
}
export class OAuthAuthorityGrantRejectedError extends OAuthAuthorityRejectedError {
  constructor() {
    super(403);
  }
}

const coreOrigin = (): string => {
  const value = env.CLOUD_CORE_INTERNAL_ORIGIN;
  if (!value) throw new Error("CLOUD_CORE_INTERNAL_ORIGIN is required for Core OAuth issuance");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("CLOUD_CORE_INTERNAL_ORIGIN must use HTTP or HTTPS");
  return url.origin;
};

const sendOAuthRequest = (url: URL, init: RequestInit, options: { fetch?: AuthorityFetch }) =>
  sendAppRequest(new Request(url, init), {
    appId: "oauth",
    transport: options.fetch,
  });

export const probeOAuthTokenAuthority = async (options: { fetch?: AuthorityFetch; origin?: string } = {}): Promise<void> => {
  const response = await sendOAuthRequest(
    new URL("/api/_internal/identity/v1/oauth/ready", options.origin ?? coreOrigin()),
    {
      method: "POST",
      redirect: "error",
      headers: {},
      signal: AbortSignal.timeout(5_000),
    },
    options,
  );
  if (!response.ok) throw new Error(`Core OAuth authority readiness failed with status ${response.status}`);
};

/** Ask Core to sign one validated, closed OAuth token batch. Deliberately never retries an uncertain request. */
export const issueOAuthTokenBatch = async (
  statement: OAuthAuthorityStatement,
  options: { fetch?: AuthorityFetch; origin?: string } = {},
): Promise<string[]> => {
  if (statement.tokens.length < 1 || statement.tokens.length > 2) throw new Error("OAuth authority accepts one or two tokens per batch");

  const response = await sendOAuthRequest(
    new URL("/api/_internal/identity/v1/oauth/token", options.origin ?? coreOrigin()),
    {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(statement),
      signal: AbortSignal.timeout(5_000),
    },
    options,
  );
  if (!response.ok) {
    if (response.status === 403) throw new OAuthAuthorityGrantRejectedError();
    if (response.status >= 400) throw new OAuthAuthorityRejectedError(response.status);
    throw new Error(`Core OAuth issuance failed with status ${response.status}`);
  }
  const parsed = AuthorityResponseSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.tokens.length !== statement.tokens.length) {
    throw new Error("Core OAuth issuance returned an invalid token batch");
  }
  return parsed.data.tokens;
};

export class OAuthDeviceApprovalUnavailableError extends Error {
  constructor(readonly status: number) {
    super(`Core OAuth device approval failed with status ${status}`);
  }
}

/** Hand one terminal sign-in to Core. An uncertain request is never retried. */
export const startOAuthDeviceApproval = async (
  request: OAuthDeviceApprovalRequest,
  options: { fetch?: AuthorityFetch; origin?: string } = {},
): Promise<{ comparison: string; expiresAt: string }> => {
  const response = await sendOAuthRequest(
    new URL("/api/_internal/identity/v1/oauth/device-approval", options.origin ?? coreOrigin()),
    {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(5_000),
    },
    options,
  );
  if (response.status !== 200) throw new OAuthDeviceApprovalUnavailableError(response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OAuthDeviceApprovalUnavailableError(response.status);
  }
  const parsed = z.object({ comparison: z.string().regex(/^\d{6}$/), expiresAt: z.string() }).safeParse(body);
  if (!parsed.success) throw new OAuthDeviceApprovalUnavailableError(response.status);
  return parsed.data;
};

/** The issuer retains pending notices; Core owns the shared notification template. */
export const sendOAuthNewAccessNotice = async (notice: OAuthIssuerNewAccessNotice): Promise<void> => {
  const response = await sendOAuthRequest(
    new URL("/api/_internal/identity/v1/oauth/new-access", coreOrigin()),
    {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(notice),
      signal: AbortSignal.timeout(5_000),
    },
    {},
  );
  if (!response.ok) throw new Error(`Core OAuth new-access notice failed with status ${response.status}`);
};
