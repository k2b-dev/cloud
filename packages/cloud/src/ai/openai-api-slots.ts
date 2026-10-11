import { redis } from "bun";
import { logger } from "../services/logging";

const LEASE_MS = 120_000;
const log = logger("ai:openai-api");
const SLOT_SCRIPT = `
  local time = redis.call("TIME")
  local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  local key = KEYS[1]
  local slot = ARGV[1]
  local leaseMs = tonumber(ARGV[2])
  redis.call("ZREMRANGEBYSCORE", key, "-inf", now)
  if ARGV[3] == "refresh" then
    if not redis.call("ZSCORE", key, slot) then return 0 end
  elseif redis.call("ZCARD", key) >= tonumber(ARGV[3]) then
    return 0
  end
  redis.call("ZADD", key, now + leaseMs, slot)
  redis.call("PEXPIRE", key, leaseMs)
  return 1
`;

export const acquire = async ({ userId, limit }: { userId: string; limit: number }): Promise<{ release(): Promise<void> } | null> => {
  const key = `cloud:ai:openai-api:slots:${userId}`;
  const slot = crypto.randomUUID();
  const granted = await redis.send("EVAL", [SLOT_SCRIPT, "1", key, slot, String(LEASE_MS), String(limit)]);
  if (granted !== 1) return null;
  const heartbeat = setInterval(() => {
    void redis
      .send("EVAL", [SLOT_SCRIPT, "1", key, slot, String(LEASE_MS), "refresh"])
      .catch(() => log.warn("OpenAI API slot heartbeat failed"));
  }, 30_000);
  heartbeat.unref();
  return {
    async release() {
      clearInterval(heartbeat);
      await redis.send("ZREM", [key, slot]);
    },
  };
};
