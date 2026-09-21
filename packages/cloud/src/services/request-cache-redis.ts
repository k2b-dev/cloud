import { RedisClient } from "bun";
import { env } from "../config/env";

// Cache commands must not queue across a disconnect: delayed fills/invalidations
// are not useful, and reads must be able to fall back to Postgres. Keep this
// connection separate from sessions, rate limits and other Redis consumers.
let client: RedisClient | undefined;
let initialConnection: Promise<void> | undefined;
let reconnecting: Promise<void> | undefined;

export const requestCacheRedis = async (): Promise<RedisClient> => {
  if (!client) {
    client = new RedisClient(env.REDIS_URL, { enableOfflineQueue: false });
    // The first operation waits for normal connection establishment (Bun's
    // connection timeout applies). Later disconnected operations fail promptly.
    initialConnection = client.connect().catch(() => {});
  }
  await initialConnection;
  if (!client.connected && !reconnecting) {
    // Bun reconnects automatically; also allow recovery after its retry limit.
    reconnecting = client
      .connect()
      .catch(() => {})
      .finally(() => {
        reconnecting = undefined;
      });
  }
  return client;
};
