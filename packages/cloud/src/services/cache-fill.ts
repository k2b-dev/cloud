import { requestCacheRedis } from "./request-cache-redis";

// Non-JSON markers remain compatible with older readers: they discard them and
// use Postgres. A marker can never be confused with a stored JSON setting value.
export const MISSING_SETTING = "!cloud:missing-setting:v1";
const FILL_PREFIX = "!cloud:cache-fill:v1:";
const COMPLETE = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
end return nil`;
const DISCARD = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end return 0`;

/** A concurrent invalidation deletes the lease, so an old read cannot refill it. */
export const claimCacheFill = async (key: string, observed: string | null): Promise<string | null> => {
  try {
    if (observed?.startsWith(FILL_PREFIX)) return null;
    const redis = await requestCacheRedis();
    if (observed !== null) await redis.send("EVAL", [DISCARD, "1", key, observed]);
    const token = FILL_PREFIX + crypto.randomUUID();
    // A slow loader may still return its value, but loses permission to cache it.
    return (await redis.send("SET", [key, token, "NX", "EX", "5"])) === "OK" ? token : null;
  } catch {
    return null;
  }
};

export const completeCacheFill = async (key: string, token: string | null, value: string, ttlSeconds: number): Promise<void> => {
  if (!token) return;
  try {
    await (await requestCacheRedis()).send("EVAL", [COMPLETE, "1", key, token, value, String(ttlSeconds)]);
  } catch {
    // A cache failure does not change a successful authoritative read.
  }
};
