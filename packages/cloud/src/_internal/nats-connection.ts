/**
 * NATS connection for @k2b/sync — one connection per app process, created by
 * the app lifecycle. Configuration comes from the platform startup snapshot; sync
 * itself reads no ENV and loads no credentials.
 */
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { connections } from "../runtime/connections";

export type ConnectNatsOptions = {
  /** Connection name shown in NATS monitoring (`connz`), e.g. `cloud-<appId>-<instanceId>`. */
  name: string;
};

/** Dial `NATS_SERVERS` once. `startProcessSync()` requires the list and retries while NATS does not answer. */
export const connectNats = async ({ name }: ConnectNatsOptions): Promise<NatsConnection> => {
  const nats = connections().nats;
  return connect({
    servers: nats.servers,
    name,
    ignoreClusterUpdates: nats.ignoreClusterUpdates,
    // Keep reconnecting for the life of the process: sync work resumes when the cluster is back.
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2_000,
    ...(nats.creds ? { authenticator: credsAuthenticator(new TextEncoder().encode(nats.creds)) } : {}),
    ...(nats.ca ? { tls: { ca: nats.ca } } : {}),
  });
};
