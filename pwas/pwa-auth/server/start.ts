import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { env } from "@k2b/cloud/config";
import { createSync } from "@k2b/sync";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { sql } from "bun";
import { appEnv } from "./env";
import { createPushService, migrate, type Vapid } from "./push";

const vapid = (): Vapid | undefined => {
  const publicKey = appEnv.CLOUD_LOGIN_VAPID_PUBLIC_KEY;
  const privateKey = appEnv.CLOUD_LOGIN_VAPID_PRIVATE_KEY;
  const subject = appEnv.CLOUD_LOGIN_VAPID_SUBJECT;
  if (!publicKey && !privateKey && !subject) return undefined;
  if (!publicKey || !privateKey || !subject)
    throw new Error("Set CLOUD_LOGIN_VAPID_PUBLIC_KEY, CLOUD_LOGIN_VAPID_PRIVATE_KEY and CLOUD_LOGIN_VAPID_SUBJECT together, or none.");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
  // A mismatched pair fails every delivery; refuse to start instead.
  if (ecdh.getPublicKey("base64url") !== publicKey) throw new Error("CLOUD_LOGIN_VAPID_PRIVATE_KEY does not match the public key.");
  return { publicKey, privateKey, subject };
};

/**
 * Starts push delivery when VAPID is configured; otherwise Cloud Login stays a
 * static app. Mirrors Cloud's process Sync setup (`connectNats` and
 * `startProcessSync`) without its trace observer, which writes to Cloud's schema.
 */
export const startPush = async () => {
  const keys = vapid();
  if (!keys) return undefined;
  if (!env.DATABASE_URL) throw new Error("Push needs DATABASE_URL (Postgres).");
  if (env.NATS_SERVERS.length === 0) throw new Error("Push needs NATS_SERVERS (NATS JetStream).");
  if (!env.SYNC_NAMESPACE.trim()) throw new Error("Push needs SYNC_NAMESPACE, e.g. cloud-login.");
  await migrate();
  const connection = await connect({
    servers: env.NATS_SERVERS,
    name: `cloud-login@${hostname()}`,
    ignoreClusterUpdates: env.NATS_IGNORE_CLUSTER_UPDATES,
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2_000,
    ...(env.NATS_CREDS_FILE ? { authenticator: credsAuthenticator(readFileSync(env.NATS_CREDS_FILE)) } : {}),
    ...(env.NATS_TLS_CA_FILE ? { tls: { caFile: env.NATS_TLS_CA_FILE } } : {}),
  });
  const sync = createSync({
    connection,
    namespace: env.SYNC_NAMESPACE,
    application: "cloud-login",
    defaults: { replicas: env.SYNC_REPLICAS },
  });
  const push = createPushService({ sync, vapid: keys });
  try {
    await sync.ready();
    await push.start();
  } catch (error) {
    await connection.close();
    throw error;
  }
  const prune = setInterval(() => {
    push.prune().catch(() => console.error("[push] rate-limit cleanup failed"));
  }, 60_000);
  return {
    push,
    stop: async () => {
      clearInterval(prune);
      try {
        await sync.drain({ timeoutMs: 10_000 });
      } finally {
        await connection.drain();
        await sql.close();
      }
    },
  };
};
