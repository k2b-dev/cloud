import { z } from "zod";
import type { GeoFunction } from "../../contracts/geo";
import { requestCacheRedis } from "../request-cache-redis";
import { busy, GeoError } from "./errors";

export type GeoRedis = { send(command: string, args: string[]): Promise<unknown> };
export const GEO_TIMEOUT_MS = { autocomplete: 2500, geocode: 5000, reverse: 5000, places: 8000, route: 15000, tiles: 10000 } as const;
// One token bucket for all paid APIs; a separate lease set for each function.
const ACQUIRE = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + tonumber(clock[2]) / 1000
local rate = tonumber(ARGV[1])
local leaseMs = tonumber(ARGV[2])
local cap = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('ZCARD', KEYS[2]) >= cap then
  local first = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
  return {0, math.max(1, math.ceil((tonumber(first[2]) - now) / 1000))}
end
local old = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = math.min(rate, tonumber(old[1]) or rate)
local at = tonumber(old[2]) or now
tokens = math.min(rate, tokens + math.max(0, now - at) * rate / 1000)
if tokens < 1 then return {0, math.max(1, math.ceil((1 - tokens) / rate))} end
redis.call('HSET', KEYS[1], 'tokens', tokens - 1, 'at', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(leaseMs + 1000))
redis.call('ZADD', KEYS[2], now + leaseMs, ARGV[4])
redis.call('PEXPIRE', KEYS[2], math.ceil(leaseMs + 1000))
return {1, 0}
`;
export const createGeoBucket = (options: { redis?: () => Promise<GeoRedis>; randomId?: () => string; prefix?: string } = {}) => {
  const client = options.redis ?? requestCacheRedis;
  const prefix = options.prefix ?? "geo:{admission}:v1";
  return {
    async acquire(fn: GeoFunction | "tiles", rps: number) {
      try {
        if (!Number.isFinite(rps) || rps < 1) throw busy();
        const id = options.randomId ? options.randomId() : crypto.randomUUID();
        const redis = await client();
        const key = `${prefix}:flight:${fn}`;
        const reply = z
          .tuple([z.number(), z.number()])
          .parse(
            await redis.send("EVAL", [
              ACQUIRE,
              "2",
              `${prefix}:bucket${fn === "tiles" ? ":tiles" : ""}`,
              key,
              String(rps),
              String(GEO_TIMEOUT_MS[fn] + 1000),
              String(Math.ceil((rps * GEO_TIMEOUT_MS[fn]) / 1000)),
              id,
            ]),
          );
        if (reply[0] !== 1) throw busy(Math.max(1, reply[1]));
        return async () => {
          await redis.send("ZREM", [key, id]).catch(() => {});
        };
      } catch (error) {
        if (error instanceof GeoError) throw error;
        // Fail closed, but leave a trace: a script or client defect must not look like ordinary load.
        console.error("[geo] Admission refused after a Valkey failure", { error: error instanceof Error ? error.name : typeof error });
        throw busy();
      }
    },
  };
};
