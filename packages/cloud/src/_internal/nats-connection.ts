/**
 * NATS connection for @k2b/sync — one connection per app process, created by
 * the app lifecycle. Configuration comes from `env` (NATS_* variables); sync
 * itself reads no ENV and loads no credentials.
 */
import { readFileSync } from "node:fs";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { env } from "../config/env";

export type ConnectNatsOptions = {
  /** Connection name shown in NATS monitoring (`connz`), e.g. `cloud-<appId>-<instanceId>`. */
  name: string;
};

/** Dial `NATS_SERVERS` once. `startProcessSync()` requires the list and retries while NATS does not answer. */
export const connectNats = async ({ name }: ConnectNatsOptions): Promise<NatsConnection> =>
  connect({
    servers: env.NATS_SERVERS,
    name,
    ignoreClusterUpdates: env.NATS_IGNORE_CLUSTER_UPDATES,
    // Keep reconnecting for the life of the process: sync work resumes when the cluster is back.
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2_000,
    ...(env.NATS_CREDS_FILE ? { authenticator: credsAuthenticator(readFileSync(env.NATS_CREDS_FILE)) } : {}),
    ...(env.NATS_TLS_CA_FILE ? { tls: { caFile: env.NATS_TLS_CA_FILE } } : {}),
  });
