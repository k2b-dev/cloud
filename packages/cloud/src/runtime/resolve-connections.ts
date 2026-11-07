import { readFileSync } from "node:fs";
import { envSource } from "../config/define-env";
import { env } from "../config/env";
import type { ConnectionSource, PlatformConnections, PlatformConnectionValues } from "./connections";

type EnvKey = keyof typeof env.$specs;
const explicitlySet = (key: EnvKey): boolean => ["env", "alias", "file"].includes(envSource(env, key));

/** URL diagnostics deliberately omit both the input and underlying parser errors. */
const url = (key: string, value: string | undefined, bareHost = false): string => {
  if (!value) throw new Error(`${key} is required for platform start`);
  try {
    const parsed = new URL(bareHost && !value.includes("://") ? `nats://${value}` : value);
    if (bareHost && !parsed.hostname) throw new Error();
  } catch {
    throw new Error(`${key} must be a valid URL${bareHost ? " or host:port" : ""}`);
  }
  return value;
};
const contents = (key: "NATS_CREDS_FILE" | "NATS_TLS_CA_FILE"): string | undefined => {
  const path = env[key];
  if (!path) return undefined;
  try {
    const value = readFileSync(path, "utf8");
    if (!value.trim()) throw new Error();
    return value;
  } catch {
    throw new Error(`${key} must name a readable, non-empty file`);
  }
};

/**
 * Explicit environment values always win, including aliases, files and false.
 * The Core bootstrap client supplies `core` in key mode; required values then
 * never fall through to environment defaults. Optional values may use defaults.
 */
export const resolveConnections = ({ appId, core }: { appId: string; core?: PlatformConnectionValues }): PlatformConnections => {
  const source = (key: EnvKey): ConnectionSource => (!core || explicitlySet(key) ? "env" : "core");
  const choose = <T>(key: EnvKey, fromEnv: () => T, fromCore: T): T => (!core || explicitlySet(key) ? fromEnv() : fromCore);
  // Keep value reads lazy: an absent env value must not evaluate its default in key mode.
  const database = url(
    "DATABASE_URL",
    choose("DATABASE_URL", () => env.DATABASE_URL, core?.database.url),
  );
  const valkey = url(
    "REDIS_URL",
    choose("REDIS_URL", () => env.REDIS_URL, core?.valkey.url),
  );
  const servers = choose("NATS_SERVERS", () => env.NATS_SERVERS, core?.nats.servers) ?? [];
  for (const server of servers) url("NATS_SERVERS", server, true);
  const namespace = choose("SYNC_NAMESPACE", () => env.SYNC_NAMESPACE, core?.nats.namespace) ?? "";
  const replicas = choose("SYNC_REPLICAS", () => env.SYNC_REPLICAS, core?.nats.replicas) ?? env.SYNC_REPLICAS;
  const ignoreClusterUpdates =
    choose("NATS_IGNORE_CLUSTER_UPDATES", () => env.NATS_IGNORE_CLUSTER_UPDATES, core?.nats.ignoreClusterUpdates) ??
    env.NATS_IGNORE_CLUSTER_UPDATES;
  const creds = choose("NATS_CREDS_FILE", () => contents("NATS_CREDS_FILE"), core?.nats.creds);
  const ca = choose("NATS_TLS_CA_FILE", () => contents("NATS_TLS_CA_FILE"), core?.nats.ca);
  const secret = choose("APP_SECRET", () => env.APP_SECRET, core?.appSecret.current) ?? "";
  const rotation = core && !explicitlySet("APP_SECRET") ? core.appSecret : undefined;
  if (core) {
    if (servers.length === 0) throw new Error("NATS_SERVERS is required for platform start");
    if (!namespace.trim()) throw new Error("SYNC_NAMESPACE is required for platform start");
    if (!secret.trim()) throw new Error("APP_SECRET is required for platform start");
  }
  if (![1, 3, 5].includes(replicas)) throw new Error("SYNC_REPLICAS must be 1, 3, or 5");
  if (typeof ignoreClusterUpdates !== "boolean") throw new Error("NATS_IGNORE_CLUSTER_UPDATES must be a boolean");
  return {
    appId,
    database: { url: database },
    valkey: { url: valkey },
    nats: { servers: [...servers], namespace, replicas, ignoreClusterUpdates, creds, ca },
    appSecret: { current: secret, previous: rotation?.previous, next: rotation?.next },
    sources: {
      database: { url: source("DATABASE_URL") },
      valkey: { url: source("REDIS_URL") },
      nats: {
        servers: source("NATS_SERVERS"),
        namespace: source("SYNC_NAMESPACE"),
        replicas: source("SYNC_REPLICAS"),
        ignoreClusterUpdates: source("NATS_IGNORE_CLUSTER_UPDATES"),
        creds: source("NATS_CREDS_FILE"),
        ca: source("NATS_TLS_CA_FILE"),
      },
      appSecret: {
        current: source("APP_SECRET"),
        ...(rotation?.previous ? { previous: "core" as const } : {}),
        ...(rotation?.next ? { next: "core" as const } : {}),
      },
    },
  };
};
