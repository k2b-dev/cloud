import { env } from "@k2b/cloud/config";
import { RedisClient } from "bun";
import { SqlError } from "./sql-errors";

// RAM plan: 3 concurrent normal profiles * 2 GB + 1 GB maintenance + 3 GB
// reserve = at least 10 GB. Large profiles require the operator to budget more.
export const CLOUD_SLOTS = 3;
export const BASE_SLOTS = 1;
export const MAX_WAITING = 20;
export const WAIT_MS = 5_000;
// Longest profile 30 s + HTTP margin 2 s + KILL budget 5 s + Valkey 1 s
// = 38 s; 40 s leases free a dead replica without renewing a running query.
export const LEASE_MS = 40_000;
const WAIT_GRACE_MS = 2_000;
const RUN_TTL_MS = WAIT_MS + LEASE_MS + WAIT_GRACE_MS;
const CLOCK = `local now=tonumber(ARGV[1]); if now<0 then local t=redis.call('TIME'); now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000) end\n`;
const ADMIT =
  CLOCK +
  `
local id,quota,count=ARGV[2],tonumber(ARGV[3]),tonumber(ARGV[4])
local deadline=tonumber(ARGV[5])
local freeOnly=ARGV[12]=='1'
local cloudSlots,baseSlots,maxWaiting,leaseMs,waitingMs,graceMs=tonumber(ARGV[6]),tonumber(ARGV[7]),tonumber(ARGV[8]),tonumber(ARGV[9]),tonumber(ARGV[10]),tonumber(ARGV[11])
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now)
redis.call('ZREMRANGEBYSCORE',KEYS[3],'-inf',now)
local reset=(math.floor(now/3600000)+1)*3600000
local old=redis.call('HMGET',KEYS[4],'reset','used')
local used=tonumber(old[1] or 0)==reset and tonumber(old[2] or 0) or 0
if redis.call('HGET',KEYS[5],'cancelled')=='1' then redis.call('ZREM',KEYS[3],id); return {'CANCELLED',used,reset,now} end
if deadline>0 and now>=deadline then redis.call('ZREM',KEYS[3],id); return {'BUSY',used,reset,now} end
if count==1 and used>=quota then redis.call('ZREM',KEYS[3],id); return {'QUOTA',used,reset,now} end
if freeOnly and redis.call('ZCARD',KEYS[3])>0 then return {'BUSY',used,reset,now} end
if redis.call('ZCARD',KEYS[1])<cloudSlots and redis.call('ZCARD',KEYS[2])<baseSlots then
 redis.call('ZREM',KEYS[3],id)
 redis.call('ZADD',KEYS[1],now+leaseMs,id); redis.call('PEXPIRE',KEYS[1],leaseMs)
 redis.call('ZADD',KEYS[2],now+leaseMs,id); redis.call('PEXPIRE',KEYS[2],leaseMs)
 if count==1 then used=used+1; redis.call('HSET',KEYS[4],'reset',reset,'used',used); redis.call('PEXPIRE',KEYS[4],math.max(1,reset-now)) end
 return {'OK',used,reset,now}
end
if freeOnly then return {'BUSY',used,reset,now} end
local waiting=redis.call('ZSCORE',KEYS[3],id)
if waiting then
 if now>=tonumber(waiting)-graceMs then redis.call('ZREM',KEYS[3],id); return {'BUSY',used,reset,now} end
else
 if redis.call('ZCARD',KEYS[3])>=maxWaiting then return {'QUEUE_FULL',used,reset,now} end
 redis.call('ZADD',KEYS[3],now+waitingMs,id); redis.call('PEXPIRE',KEYS[3],waitingMs)
end
return {'WAIT',used,reset,now}`;
const RELEASE = `redis.call('ZREM',KEYS[1],ARGV[1]); redis.call('ZREM',KEYS[2],ARGV[1]); redis.call('ZREM',KEYS[3],ARGV[1]); return 1`;
const REGISTER = `if redis.call('EXISTS',KEYS[1])==1 then return 0 end; redis.call('HSET',KEYS[1],'actor',ARGV[1],'cancelled','0'); redis.call('PEXPIRE',KEYS[1],tonumber(ARGV[2])); return 1`;
const CANCEL = `if redis.call('HGET',KEYS[1],'actor')~=ARGV[1] then return 0 end; redis.call('HSET',KEYS[1],'cancelled','1'); return 1`;
const USAGE =
  CLOCK +
  `local reset=(math.floor(now/3600000)+1)*3600000; local v=redis.call('HMGET',KEYS[1],'reset','used'); return {tonumber(v[1] or 0)==reset and tonumber(v[2] or 0) or 0,reset}`;
export type AdmissionInput = {
  baseId: string;
  runId: string;
  quota: number;
  countQuota?: boolean;
  freeOnly?: boolean;
  signal?: AbortSignal;
};
export type SqlAdmission = ReturnType<typeof createSqlAdmission>;

/** A dedicated fail-closed connection. testOnly clock/poll hooks are explicit,
 * never environment-driven; production Lua uses Valkey TIME across replicas. */
export const createSqlAdmission = (
  options: { url?: string; namespace?: string; testOnly?: { nowMs?: () => number; poll?: (signal?: AbortSignal) => Promise<void> } } = {},
) => {
  let client: RedisClient | undefined, connecting: Promise<void> | undefined;
  const prefix = options.namespace ?? "pulse:sql";
  const close = () => {
    client?.close();
    client = undefined;
    connecting = undefined;
  };
  const clock = () => String(options.testOnly?.nowMs?.() ?? -1);
  const runKey = (baseId: string, runId: string) => `${prefix}:run:${baseId}:${runId}`;
  const keys = (baseId: string) => [`${prefix}:cloud`, `${prefix}:base:${baseId}`, `${prefix}:waiting`];
  const send = async (command: string, args: string[]) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      client ??= new RedisClient(options.url ?? env.REDIS_URL, { enableOfflineQueue: false, connectionTimeout: 1000 });
      const current = client;
      const operation = async () => {
        if (!current.connected) {
          connecting ??= current.connect().finally(() => {
            connecting = undefined;
          });
          await connecting;
        }
        return current.send(command, args);
      };
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Admission timeout")), 1000);
        }),
      ]);
    } catch {
      close();
      throw new SqlError("STORE_UNAVAILABLE", "Pulse admission is unavailable. Retry later.");
    } finally {
      clearTimeout(timer);
    }
  };
  const evalScript = (script: string, keys: string[], args: string[]) => send("EVAL", [script, String(keys.length), ...keys, ...args]);
  const release = async (baseId: string, runId: string) => {
    await evalScript(RELEASE, keys(baseId), [`${baseId}:${runId}`]);
  };
  const check = async (input: AdmissionInput, deadlineMs = 0) => {
    // A monotonic local deadline starts before the admission round trip, so
    // network latency can only shorten the database work window.
    const executionDeadline = performance.now() + LEASE_MS - 5_000;
    const reply = await evalScript(
      ADMIT,
      [...keys(input.baseId), `${prefix}:quota:${input.baseId}`, runKey(input.baseId, input.runId)],
      [
        clock(),
        `${input.baseId}:${input.runId}`,
        String(input.quota),
        input.countQuota === false ? "0" : "1",
        String(deadlineMs),
        String(CLOUD_SLOTS),
        String(BASE_SLOTS),
        String(MAX_WAITING),
        String(LEASE_MS),
        String(WAIT_MS + WAIT_GRACE_MS),
        String(WAIT_GRACE_MS),
        input.freeOnly ? "1" : "0",
      ],
    );
    if (!Array.isArray(reply)) throw new SqlError("STORE_UNAVAILABLE", "Invalid admission response");
    return {
      executionDeadline,
      state: String(reply[0]),
      used: Number(reply[1]),
      resetAt: new Date(Number(reply[2])).toISOString(),
      nowMs: Number(reply[3]),
    };
  };
  const pause =
    options.testOnly?.poll ??
    ((signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(new SqlError("CANCELLED", "Query cancelled"));
        };
        const timer = setTimeout(done, 100);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }));
  return {
    close,
    check,
    release,
    async acquire(input: AdmissionInput) {
      let deadlineMs = 0;
      try {
        for (;;) {
          if (input.signal?.aborted) throw new SqlError("CANCELLED", "Query cancelled");
          const result = await check(input, deadlineMs);
          if (result.state === "OK") return { ...result, release: () => release(input.baseId, input.runId) };
          if (result.state === "WAIT") {
            deadlineMs ||= result.nowMs + WAIT_MS;
            await pause(input.signal);
            continue;
          }
          if (result.state === "QUOTA")
            throw new SqlError("QUOTA", "The hourly question quota is reached", {
              resetAt: result.resetAt,
              retryAfter: Math.max(1, Math.ceil((Date.parse(result.resetAt) - result.nowMs) / 1000)),
            });
          if (result.state === "CANCELLED") throw new SqlError("CANCELLED", "Query cancelled");
          if (result.state === "BUSY" || result.state === "QUEUE_FULL")
            throw new SqlError(result.state, "Pulse is busy. Retry later.", { retryAfter: 5 });
          throw new SqlError("STORE_UNAVAILABLE", "Invalid admission response");
        }
      } catch (error) {
        await release(input.baseId, input.runId).catch(() => {});
        throw error;
      }
    },
    async usage(baseId: string) {
      const value = await evalScript(USAGE, [`${prefix}:quota:${baseId}`], [clock()]);
      if (!Array.isArray(value)) throw new SqlError("STORE_UNAVAILABLE", "Invalid quota response");
      return { used: Number(value[0]), resetAt: new Date(Number(value[1])).toISOString() };
    },
    async register(baseId: string, runId: string, actorId: string) {
      return Number(await evalScript(REGISTER, [runKey(baseId, runId)], [actorId, String(RUN_TTL_MS)])) === 1;
    },
    async cancel(baseId: string, runId: string, actorId: string) {
      return Number(await evalScript(CANCEL, [runKey(baseId, runId)], [actorId])) === 1;
    },
    async cancelled(baseId: string, runId: string) {
      return (await send("HGET", [runKey(baseId, runId), "cancelled"])) === "1";
    },
    async forget(baseId: string, runId: string) {
      await send("DEL", [runKey(baseId, runId)]);
    },
    // Source counts share the same bounded connection and are never question quota.
    async cached(key: string) {
      const value = await send("GET", [`${prefix}:counts:${key}`]);
      return typeof value === "string" ? value : null;
    },
    async cache(key: string, value: string) {
      await send("SET", [`${prefix}:counts:${key}`, value, "EX", "300"]);
    },
  };
};
export const sqlAdmission = createSqlAdmission();
