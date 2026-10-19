import { env } from "@k2b/cloud/config";
import { RedisClient } from "bun";

// One minute of burst capacity, continuous refill. Redis TIME keeps replicas on one clock.
const SCRIPT = `
local t=redis.call('TIME')
local now=tonumber(t[1])*1000+tonumber(t[2])/1000
local vcap,bcap=tonumber(ARGV[1]),tonumber(ARGV[2])
local values,bytes=tonumber(ARGV[3]),tonumber(ARGV[4])
local prev=redis.call('HMGET',KEYS[1],'at','values','bytes')
local elapsed=math.max(0,now-tonumber(prev[1] or now))
local v=math.min(vcap,tonumber(prev[2] or vcap)+elapsed*vcap/60000)
local b=math.min(bcap,tonumber(prev[3] or bcap)+elapsed*bcap/60000)
local wait=math.max(0,(values-v)*60000/vcap,(bytes-b)*60000/bcap)
if wait>0 then return math.max(1,math.ceil(wait/1000)) end
redis.call('HSET',KEYS[1],'at',now,'values',v-values,'bytes',b-bytes)
redis.call('PEXPIRE',KEYS[1],120000)
return 0`;

export type QuotaError = {
  code: "PULSE_BASE_THROTTLED" | "PULSE_QUOTA_UNAVAILABLE";
  status: 429 | 503;
  message: string;
  retryAfter: number;
};
export type QuotaInput = { baseId: string; values: number; bytes: number; valuesPerMinute: number; bytesPerMinute: number };
export type IngestQuota = { consume: (input: QuotaInput) => Promise<QuotaError | null>; close: () => void };

/** A dedicated connection: never queue quota decisions while disconnected. Every call has a 1 s budget. */
export const createIngestQuota = (url?: string): IngestQuota => {
  let client: RedisClient | undefined;
  let connecting: Promise<void> | undefined;
  const close = () => {
    client?.close();
    client = undefined;
    connecting = undefined;
  };
  return {
    close,
    consume: async (input) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        client ??= new RedisClient(url ?? env.REDIS_URL, { enableOfflineQueue: false, connectionTimeout: 1000 });
        const current = client;
        const operation = async () => {
          if (!current.connected) {
            connecting ??= current.connect().finally(() => {
              connecting = undefined;
            });
            await connecting;
          }
          return Number(
            await current.send("EVAL", [
              SCRIPT,
              "1",
              `pulse:quota:${input.baseId}`,
              String(input.valuesPerMinute),
              String(input.bytesPerMinute),
              String(input.values),
              String(input.bytes),
            ]),
          );
        };
        const wait = await Promise.race([
          operation(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Quota timeout")), 1000);
          }),
        ]);
        if (!Number.isFinite(wait)) throw new Error("Invalid quota result");
        return wait > 0
          ? {
              code: "PULSE_BASE_THROTTLED",
              status: 429,
              message: "Pulse base is throttled. Retry after the indicated delay.",
              retryAfter: Math.max(1, Math.ceil(wait)),
            }
          : null;
      } catch {
        // Closing also cancels a timed-out command; no command survives to consume a later bucket.
        close();
        return {
          code: "PULSE_QUOTA_UNAVAILABLE",
          status: 503,
          message: "Pulse quota service is unavailable. Retry later.",
          retryAfter: 30,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
};
export const ingestQuota = createIngestQuota();
