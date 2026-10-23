import { env } from "@k2b/cloud/config";
import { RedisClient } from "bun";
import { z } from "zod";
import { DASHBOARD_CACHE_BYTES, DASHBOARD_CACHE_ENTRIES } from "../dashboard-contracts";

export const DashboardSnapshotSchema = z.object({
  at: z.string(),
  from: z.string(),
  to: z.string(),
  slot: z.string(),
  data: z.object({ columns: z.array(z.object({ name: z.string(), type: z.string() })), rows: z.array(z.array(z.unknown())) }),
});
export type DashboardSnapshot = z.infer<typeof DashboardSnapshotSchema>;
// This cache owns results only. Durable execution receipts prevent eviction or a
// Valkey restart from authorizing another calculation in the same interval.
// Values remain opaque JSON strings: Lua cjson would turn empty arrays into objects.
const PUT = `
local key,value=ARGV[1],ARGV[2]
local maxEntries,maxBytes=tonumber(ARGV[3]),tonumber(ARGV[4])
local size=string.len(key)+string.len(value)
if size>maxBytes then return 0 end
local previous=redis.call('HGET',KEYS[1],key)
if previous and cjson.decode(previous).slot>cjson.decode(value).slot then return 0 end
local previousSize=previous and string.len(key)+string.len(previous) or 0
redis.call('HSET',KEYS[1],key,value)
local total=redis.call('INCRBY',KEYS[3],size-previousSize)
local t=redis.call('TIME'); local now=tonumber(t[1])*1000000+tonumber(t[2])
redis.call('ZADD',KEYS[2],now,key)
local count=redis.call('HLEN',KEYS[1])
for _,oldKey in ipairs(redis.call('ZRANGE',KEYS[2],0,-1)) do
 if count<=maxEntries and total<=maxBytes then break end
 local oldSize=redis.call('HSTRLEN',KEYS[1],oldKey)
 if oldSize>0 then total=total-string.len(oldKey)-oldSize;count=count-1;redis.call('HDEL',KEYS[1],oldKey) end
 redis.call('ZREM',KEYS[2],oldKey)
end
redis.call('SET',KEYS[3],total)
return redis.call('HEXISTS',KEYS[1],key)`;
export const createDashboardCache = (options: { url?: string; namespace?: string } = {}) => {
  let client: RedisClient | undefined;
  let connecting: Promise<void> | undefined;
  const prefix = options.namespace ?? "pulse:dashboards:v2";
  const close = () => {
    client?.close();
    client = undefined;
    connecting = undefined;
  };
  const send = async (command: string, args: string[]) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      client ??= new RedisClient(options.url ?? env.REDIS_URL, { enableOfflineQueue: false, connectionTimeout: 1000 });
      const connection = client;
      const work = async () => {
        if (!connection.connected) {
          connecting ??= connection.connect().finally(() => {
            connecting = undefined;
          });
          await connecting;
        }
        return connection.send(command, args);
      };
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Dashboard cache unavailable")), 1000);
        }),
      ]);
    } catch (error) {
      close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    close,
    async read(key: string): Promise<DashboardSnapshot | null> {
      const raw = await send("HGET", [`${prefix}:entries`, key]);
      return typeof raw === "string" ? DashboardSnapshotSchema.parse(JSON.parse(raw)) : null;
    },
    async put(key: string, snapshot: DashboardSnapshot) {
      return (
        Number(
          await send("EVAL", [
            PUT,
            "3",
            `${prefix}:entries`,
            `${prefix}:age`,
            `${prefix}:bytes`,
            key,
            JSON.stringify({ ...snapshot, slot: new Date(snapshot.slot).toISOString() }),
            String(DASHBOARD_CACHE_ENTRIES),
            String(DASHBOARD_CACHE_BYTES),
          ]),
        ) === 1
      );
    },
  };
};
export const dashboardCache = createDashboardCache();
