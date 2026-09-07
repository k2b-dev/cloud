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

export const connectNats = async ({ name }: ConnectNatsOptions): Promise<NatsConnection> => {
  if (env.NATS_SERVERS.length === 0) {
    throw new Error(
      `NATS_SERVERS is not set (connection "${name}"). @k2b/sync needs a comma-separated list of ` +
        "nats://host:port bootstrap servers, e.g. NATS_SERVERS=nats://ipa_nats_1:4222,nats://ipa_nats_2:4222.",
    );
  }

  return connect({
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
};
