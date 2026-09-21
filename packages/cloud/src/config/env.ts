/**
 * Platform environment registry.
 * Every variable a Cloud process reads is declared here or in an application's
 * `src/env.ts`; values are parsed lazily on access (see `define-env.ts`).
 */
import { z } from "zod";
import { defineEnv, envBoolean, envList } from "./define-env";

const syncReplicas = z
  .enum(["1", "3", "5"], { error: "must be 1, 3, or 5" })
  .transform((value): 1 | 3 | 5 => (value === "1" ? 1 : value === "3" ? 3 : 5));

const registry = defineEnv({
  // Process
  NODE_ENV: {
    schema: z.string(),
    doc: "Release images set `production`; `development` enables development-only behavior such as insecure cookies and HTTP issuers.",
  },
  HOSTNAME: {
    schema: z.string(),
    doc: "Container or host name; the default instance identity in worker leases and gateway registration.",
  },

  // Infrastructure
  DATABASE_URL: {
    schema: z.string(),
    example: "postgresql://ipa:ipa@localhost:5432/ipa",
    doc: "Postgres connection read by Bun SQL and by application-owned pools.",
  },
  REDIS_URL: {
    schema: z.string(),
    aliases: ["VALKEY_URL"],
    example: "redis://localhost:6379",
    doc: "Valkey connection used by Bun Redis for caches and rate limits.",
  },
  NATS_SERVERS: {
    schema: envList,
    default: [],
    example: "nats://localhost:4222",
    doc: "Comma-separated NATS JetStream bootstrap servers; the client dials all of them.",
  },
  SYNC_NAMESPACE: {
    schema: z.string(),
    default: "",
    example: "dev",
    doc: "Sync namespace shared by every app of one installation; isolates its NATS resources from other installations on the same cluster.",
  },
  SYNC_REPLICAS: {
    schema: syncReplicas,
    default: 3,
    example: "1",
    doc: "Persistent JetStream replica count (1, 3 or 5); keep it consistent across the installation and migrate existing resources before changing it.",
  },
  NATS_CREDS_FILE: {
    schema: z.string(),
    doc: "Path to a mounted NATS `.creds` file (JWT and NKey); unset means server-side no-auth.",
  },
  NATS_TLS_CA_FILE: {
    schema: z.string(),
    doc: "Path to a mounted CA certificate that enables TLS to NATS; unset means plain TCP.",
  },
  NATS_IGNORE_CLUSTER_UPDATES: {
    schema: envBoolean,
    default: true,
    example: "true",
    doc: "Only dial the listed servers and ignore cluster-advertised peer addresses; set to `false` when every advertised address is reachable.",
  },

  // Installation
  APP_URL: {
    schema: z.string(),
    example: "localhost:3000",
    doc: "Public Cloud URL used to bootstrap the `app.url` setting; the stored setting wins once written.",
  },
  APP_SECRET: {
    schema: z.string(),
    default: "",
    scope: "secret",
    example: "change-me-generate-with-openssl-rand-hex-32",
    doc: "Deployment-wide secret for at-rest settings encryption and signed cursors; generate once with `openssl rand -hex 32` and never change it after data has been written.",
  },
  ADMIN_LOGIN_TOKEN: {
    schema: z.string(),
    default: "",
    scope: "secret",
    doc: "Core only: temporary first-administrator or recovery login token; remove it after normal administrator sign-in works.",
  },

  // Identity and OAuth
  CLOUD_IDENTITY_KEY_ENCRYPTION_KEY: {
    schema: z.string(),
    scope: "secret",
    example: "change-me-generate-with-openssl-rand-hex-32",
    doc: "Core only: 64-hex KEK for platform identity signing keys stored in Postgres; generate once with `openssl rand -hex 32` and never distribute it to other apps.",
  },
  CLOUD_IDENTITY_NEXT_KEY: {
    schema: z.string(),
    scope: "secret",
    doc: "Core only: pre-distributed next KEK before promoting it to current; cannot be combined with `CLOUD_IDENTITY_PREVIOUS_KEY`.",
  },
  CLOUD_IDENTITY_PREVIOUS_KEY: {
    schema: z.string(),
    scope: "secret",
    doc: "Core only: old KEK set during an explicit rolling rewrap of stored identity signing keys, then removed.",
  },
  CLOUD_OAUTH_BROKER_SECRET: {
    schema: z.string(),
    scope: "secret",
    doc: "Core and OAuth only: 64-hex secret that lets the OAuth app request token signatures from Core; generate independently with `openssl rand -hex 32`.",
  },
  CLOUD_CORE_INTERNAL_ORIGIN: {
    schema: z.string(),
    doc: "Direct Core listener origin for OAuth issuance, mandate-backed background work and internal callbacks; host-run callers use the Core port, not the gateway.",
  },
  CLOUD_APP_CREDENTIAL: {
    schema: z.string(),
    scope: "secret",
    doc: "App-bound workload credential provisioned through Core's admin workload API; background apps such as Mail need one with `identity:invoke`.",
  },
  CLOUD_IDENTITY_JWKS_ORIGIN: {
    schema: z.string(),
    doc: "Optional private origin of the Core listener for session and invocation JWKS; unset fetches keys from the public issuer origin.",
  },
  CLOUD_OAUTH_JWKS_ORIGIN: {
    schema: z.string(),
    doc: "Optional private origin of the OAuth listener for OAuth JWKS; unset fetches keys from the public issuer origin.",
  },

  // Build and standalone development
  APP_DIR: {
    schema: z.string(),
    scope: "development",
    doc: "Application directory for standalone consumers running `@k2b/cloud/scripts/build.ts` or the SSR dev server outside the monorepo; defaults to the package directory.",
  },

  // Desktop
  CLOUD_DESKTOP_SQLITE_PATH: {
    schema: z.string(),
    scope: "development",
    doc: "SQLite file used by `desktop.sql` in the Bun desktop process; defaults to `.local/desktop.sqlite` in the working directory.",
  },
});

type PlatformEnv = typeof registry & { readonly IS_DEVELOPMENT: boolean };

/** Platform environment; `IS_DEVELOPMENT` derives from `NODE_ENV === "development"`. */
export const env: PlatformEnv = Object.defineProperty(registry as PlatformEnv, "IS_DEVELOPMENT", {
  enumerable: true,
  get: () => registry.NODE_ENV === "development",
});
