import { z } from "zod";

export type OAuthUserGrantReference =
  | { kind: "authorization_code"; code: string; nonce: string }
  | { kind: "refresh_token"; tokenId: string; nonce: string };

export type OAuthClientCredentialsGrantReference = { kind: "client_credentials"; grantId: string; nonce: string };

export type UserAccessTokenRequest = {
  kind: "user_access";
  grant: OAuthUserGrantReference;
  expiresIn: number;
};

export type UserIdTokenRequest = {
  kind: "user_id";
  grant: OAuthUserGrantReference;
  expiresIn: number;
};

export type ServiceAccessTokenRequest = {
  kind: "service_access";
  grant: OAuthClientCredentialsGrantReference;
  expiresIn: number;
};

export type OAuthTokenRequest = UserAccessTokenRequest | UserIdTokenRequest | ServiceAccessTokenRequest;

const AuthorityResponseSchema = z.object({
  tokens: z.array(z.string().min(1).max(16_384)).min(1).max(2),
});

type AuthorityFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class OAuthAuthorityGrantRejectedError extends Error {
  constructor() {
    super("Core rejected the current OAuth grant authority");
  }
}

const coreOrigin = (): string => {
  const value = process.env.CLOUD_CORE_INTERNAL_ORIGIN?.trim();
  if (!value) throw new Error("CLOUD_CORE_INTERNAL_ORIGIN is required for Core OAuth issuance");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("CLOUD_CORE_INTERNAL_ORIGIN must use HTTP or HTTPS");
  return url.origin;
};

export const probeOAuthTokenAuthority = async (
  options: { fetch?: AuthorityFetch; credential?: string; origin?: string } = {},
): Promise<void> => {
  const credential = options.credential ?? process.env.CLOUD_APP_CREDENTIAL?.trim();
  if (!credential) throw new Error("CLOUD_APP_CREDENTIAL is required for Core OAuth issuance");
  const response = await (options.fetch ?? globalThis.fetch)(
    new URL("/api/_internal/identity/v1/oauth/ready", options.origin ?? coreOrigin()),
    {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) throw new Error(`Core OAuth authority readiness failed with status ${response.status}`);
};

/** Ask Core to sign one validated, closed OAuth token batch. Deliberately never retries an uncertain request. */
export const issueOAuthTokenBatch = async (
  requests: OAuthTokenRequest[],
  options: { fetch?: AuthorityFetch; credential?: string; origin?: string } = {},
): Promise<string[]> => {
  if (requests.length < 1 || requests.length > 2) throw new Error("OAuth authority accepts one or two tokens per batch");
  const credential = options.credential ?? process.env.CLOUD_APP_CREDENTIAL?.trim();
  if (!credential) throw new Error("CLOUD_APP_CREDENTIAL is required for Core OAuth issuance");

  const response = await (options.fetch ?? globalThis.fetch)(
    new URL("/api/_internal/identity/v1/oauth/token", options.origin ?? coreOrigin()),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tokens: requests }),
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 403) throw new OAuthAuthorityGrantRejectedError();
  if (!response.ok) throw new Error(`Core OAuth issuance failed with status ${response.status}`);
  const parsed = AuthorityResponseSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.tokens.length !== requests.length) {
    throw new Error("Core OAuth issuance returned an invalid token batch");
  }
  return parsed.data.tokens;
};
