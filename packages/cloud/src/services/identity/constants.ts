export const CLOUD_IDENTITY_JWKS_PATH = "/.well-known/cloud-identity-jwks.json";
export const CLOUD_SESSION_TOKEN_TYPE = "cloud-session+jwt";
export const CLOUD_SESSION_AUDIENCE = "cloud";
export const CLOUD_IDENTITY_ALGORITHM = "RS256";

export const IDENTITY_CLOCK_TOLERANCE_SECONDS = 30;
export const IDENTITY_JWKS_MAX_AGE_SECONDS = 5 * 60;
export const IDENTITY_ACTIVATION_LEAD_MS = 10 * 60_000;
export const IDENTITY_SIGNING_CACHE_MS = 60_000;
export const IDENTITY_ROTATION_AGE_MS = 30 * 24 * 60 * 60_000;
export const IDENTITY_ROLLOUT_MARGIN_MS = 10 * 60_000;
export const IDENTITY_MAX_COMPACT_TOKEN_BYTES = 4 * 1024;
