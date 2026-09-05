export const CLOUD_SESSION_JWKS_PATH = "/.well-known/cloud-session-jwks.json";
export const CLOUD_INVOCATION_JWKS_PATH = "/.well-known/cloud-invocation-jwks.json";
export const CLOUD_OAUTH_JWKS_PATH = "/.well-known/jwks.json";
export const CLOUD_SESSION_TOKEN_TYPE = "cloud-session+jwt";
export const CLOUD_SESSION_AUDIENCE = "cloud";
export const CLOUD_INVOCATION_TOKEN_TYPE = "cloud-invocation+jwt";
export const CLOUD_INVOCATION_PROTOCOL_VERSION = 1 as const;
export const CLOUD_INVOCATION_TOKEN_TTL_SECONDS = 30;
export const CLOUD_IDENTITY_ALGORITHM = "RS256";

export const IDENTITY_CLOCK_TOLERANCE_SECONDS = 30;
export const INVOCATION_CLOCK_TOLERANCE_SECONDS = 2;
export const IDENTITY_JWKS_MAX_AGE_SECONDS = 5 * 60;
export const IDENTITY_ACTIVATION_LEAD_MS = 10 * 60_000;
export const IDENTITY_SIGNING_CACHE_MS = 60_000;
export const IDENTITY_ROTATION_AGE_MS = 30 * 24 * 60 * 60_000;
export const IDENTITY_ROLLOUT_MARGIN_MS = 10 * 60_000;
export const IDENTITY_MAX_COMPACT_TOKEN_BYTES = 4 * 1024;
