import { redis } from "../runtime/clients";

export const LIVE_DICTATION_LEASE_MS = 15_000;
const reserveScript = `
local time = redis.call('TIME')
local now = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now)
if redis.call('EXISTS',KEYS[1]) == 1 then return 'busy_elsewhere' end
if tonumber(redis.call('GET',KEYS[3]) or '0') >= tonumber(ARGV[4]) then return 'daily_limit' end
if redis.call('ZCARD',KEYS[2]) >= tonumber(ARGV[3]) then return 'overloaded' end
redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[2])
redis.call('ZADD',KEYS[2],now+tonumber(ARGV[2]),ARGV[1])
redis.call('PEXPIRE',KEYS[2],ARGV[2])
return 'ok'`;
const renewScript = `
if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
local time = redis.call('TIME')
local now = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)
local expiry = redis.call('ZSCORE',KEYS[2],ARGV[1])
if not expiry or tonumber(expiry) <= now then return 0 end
redis.call('PEXPIRE',KEYS[1],ARGV[2])
redis.call('ZADD',KEYS[2],now+tonumber(ARGV[2]),ARGV[1])
redis.call('PEXPIRE',KEYS[2],ARGV[2])
return 1`;
const chargeScript = `
if redis.call('GET',KEYS[1]) ~= ARGV[1] then return -1 end
local used = redis.call('INCRBYFLOAT',KEYS[2],ARGV[2])
redis.call('PEXPIRE',KEYS[2],ARGV[3])
return used`;
const releaseScript = `
if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('DEL',KEYS[1]) end
redis.call('ZREM',KEYS[2],ARGV[1])
return 1`;

/** A local calendar day, including 23/25-hour daylight-saving days. */
export const liveDictationDay = (now: number, timeZone: string) => {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const day = format.format(now);
  let lower = now;
  let upper = now + 27 * 3_600_000;
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (format.format(middle) === day) lower = middle;
    else upper = middle;
  }
  return { day, resetsAt: upper };
};

/** One atomic reservation for the person and installation, shared by all Core replicas. */
export const createLiveDictationLimits = (namespace = "ai:live-dictation") => {
  const keys = (userId: string) => [`${namespace}:person:${userId}`, `${namespace}:slots`];
  const daily = (userId: string, now: number, timeZone: string) => {
    const window = liveDictationDay(now, timeZone);
    return { ...window, key: `${namespace}:day:${userId}:${window.day}` };
  };
  return {
    async reserve(input: {
      userId: string;
      token: string;
      now: number;
      concurrency: number;
      minutesPerDay: number;
      timeZone: string;
    }): Promise<{ result: "ok" | "busy_elsewhere" | "overloaded" | "daily_limit"; resetsAt: string }> {
      const window = daily(input.userId, input.now, input.timeZone);
      const result: unknown = await redis.send("EVAL", [
        reserveScript,
        "3",
        ...keys(input.userId),
        window.key,
        input.token,
        String(LIVE_DICTATION_LEASE_MS),
        String(input.concurrency),
        String(input.minutesPerDay * 60),
      ]);
      if (result !== "ok" && result !== "busy_elsewhere" && result !== "overloaded" && result !== "daily_limit")
        throw new Error("Invalid dictation reservation result");
      return { result, resetsAt: new Date(window.resetsAt).toISOString() };
    },
    async renew(userId: string, token: string) {
      return (await redis.send("EVAL", [renewScript, "2", ...keys(userId), token, String(LIVE_DICTATION_LEASE_MS)])) === 1;
    },
    async charge(userId: string, token: string, from: number, until: number, timeZone: string) {
      let cursor = from;
      let used = 0;
      let window = daily(userId, until, timeZone);
      while (cursor < until) {
        window = daily(userId, cursor, timeZone);
        const end = Math.min(until, window.resetsAt);
        const result: unknown = await redis.send("EVAL", [
          chargeScript,
          "2",
          keys(userId)[0]!,
          window.key,
          token,
          String((end - cursor) / 1000),
          String(Math.max(1, window.resetsAt - until)),
        ]);
        used = Number(result);
        if (!Number.isFinite(used) || used < 0) return null;
        cursor = end;
      }
      // At midnight the old day is already expired; the new day's balance starts at zero.
      window = daily(userId, until, timeZone);
      used = Number((await redis.get(window.key)) ?? 0);
      return { usedSeconds: used, resetsAt: new Date(window.resetsAt).toISOString() };
    },
    async release(userId: string, token: string) {
      await redis.send("EVAL", [releaseScript, "2", ...keys(userId), token]);
    },
  };
};
export const liveDictationLimits = createLiveDictationLimits();
