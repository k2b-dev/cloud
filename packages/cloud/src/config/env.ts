/**
 * Environment variable parsing.
 * All env vars are parsed and validated here, then exported as typed `env` object.
 */

const str = (key: string, fallback: string = ""): string => process.env[key] ?? fallback;

const optional = (key: string): string | undefined => process.env[key]?.trim() || undefined;

const int = (key: string, fallback: number): number => {
  const value = process.env[key];
  const parsed = parseInt(value ?? "", 10);
  return isNaN(parsed) ? fallback : parsed;
};

const bool = (key: string, fallback: boolean): boolean => {
  const value = process.env[key]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "true" || value === "1";
};

const list = (key: string): string[] =>
  (process.env[key] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

export const env = {
  // Application (infrastructure — not changeable at runtime)
  APP_SECRET: str("APP_SECRET"),
  PORT: int("PORT", 3000),
  IS_DEVELOPMENT: process.env.NODE_ENV === "development",

  // Admin login (local emergency access — token-based, no IPA required)
  ADMIN_LOGIN_TOKEN: str("ADMIN_LOGIN_TOKEN"),

  // NATS / @k2b/sync (Postgres and Redis are read by Bun from DATABASE_URL / REDIS_URL)
  /** Bootstrap servers, comma-separated `nats://host:port` URLs. Required by `connectNats()`. */
  NATS_SERVERS: list("NATS_SERVERS"),
  /** Sync namespace shared by every app of one Cloud installation (e.g. `dev`, `prod`). Required. */
  SYNC_NAMESPACE: str("SYNC_NAMESPACE"),
  /** Path to a mounted NATS `.creds` file (JWT + NKey). Unset = server-side no-auth. */
  NATS_CREDS_FILE: optional("NATS_CREDS_FILE"),
  /** Path to a mounted CA certificate; enables TLS with that CA. Unset = plain TCP. */
  NATS_TLS_CA_FILE: optional("NATS_TLS_CA_FILE"),
  /**
   * Default true: only dial the servers listed in NATS_SERVERS. Clustered
   * nodes gossip their peers' advertised addresses, which are Docker-internal
   * hostnames (`ipa_nats_2`) that host-side clients (tests, `dev:cld` tooling)
   * cannot resolve. Set to `false` when clients can reach every advertised
   * address and should learn new nodes at runtime.
   */
  NATS_IGNORE_CLUSTER_UPDATES: bool("NATS_IGNORE_CLUSTER_UPDATES", true),
} as const;
