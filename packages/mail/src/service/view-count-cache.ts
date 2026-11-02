import { redis, sql } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import { z } from "zod";
import { conversationViewSchema } from "../contracts";
import type { ConversationViewCounts } from "./messages";

// The snapshot may be reused for 30 seconds. Reads in its second half quietly renew it.
// Live invalidations change its Postgres version in the writer's transaction, so the
// next covering workspace read cannot reuse the pre-action snapshot.
export const VIEW_COUNT_MAX_AGE_MS = 30_000;
const REFRESH_AFTER_MS = VIEW_COUNT_MAX_AGE_MS / 2;
const FILL_WAIT_MS = VIEW_COUNT_MAX_AGE_MS;
const FILL_LEASE_MS = 10_000; // Cloud's normal request idle budget; crashed owners release themselves.
const CACHE_COMMAND_MS = 100;
const log = logger("mail:view-count-cache");
const snapshotSchema = z.object({
  at: z.number().finite(),
  counts: z.record(conversationViewSchema, z.number().int().nonnegative()),
});
export class CountRefreshBusy extends Error {}

const pending = new Map<string, Promise<ConversationViewCounts>>();
const complete = `redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
return 1`;
const renew = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end return 0`;
const release = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

// The shared client can queue while disconnected. A cache may not hold a Mail
// request hostage. Snapshot age is checked on reads; lease release always requires its token.
const command = async (name: string, args: string[]): Promise<unknown> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      redis.send(name, args),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Mail count cache unavailable")), CACHE_COMMAND_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const read = async (key: string) => {
  const raw = await command("GET", [key]);
  if (typeof raw !== "string") return null;
  try {
    const parsed = snapshotSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || Date.now() - parsed.data.at >= VIEW_COUNT_MAX_AGE_MS || parsed.data.at > Date.now()) return null;
    return parsed.data;
  } catch {
    return null;
  }
};

// Leave one shared connection available for the rest of the workspace. This also bounds
// fallback computations during a Valkey outage; different readers never share a snapshot.
const activeLoads = new Set<Promise<ConversationViewCounts>>();
const loadLimit = () => Math.max(1, (sql.options.max ?? 10) - 1);
const waitFor = async <T>(task: Promise<T>, ms = FILL_WAIT_MS): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CountRefreshBusy("Mailbox counts are still refreshing; retry the request")), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const boundedLoad = async (load: () => Promise<ConversationViewCounts>) => {
  const deadline = Date.now() + FILL_WAIT_MS;
  while (activeLoads.size >= loadLimit()) {
    await waitFor(Promise.race([...activeLoads].map((task) => task.catch(() => undefined))), deadline - Date.now());
  }
  const task = load();
  activeLoads.add(task);
  try {
    return await task;
  } finally {
    activeLoads.delete(task);
  }
};

const fill = (key: string, load: () => Promise<ConversationViewCounts>): Promise<ConversationViewCounts> => {
  const existing = pending.get(key);
  if (existing) return existing;
  const task = (async () => {
    const token = crypto.randomUUID();
    const leaseKey = `${key}:fill`;
    const deadline = Date.now() + FILL_WAIT_MS;
    let claimed = false;
    try {
      for (;;) {
        claimed = (await command("SET", [leaseKey, token, "NX", "PX", String(FILL_LEASE_MS)])) === "OK";
        if (claimed) break;
        const snapshot = await read(key);
        if (snapshot) return snapshot.counts;
        if (Date.now() >= deadline) throw new CountRefreshBusy("Mailbox counts are still refreshing; retry the request");
        await Bun.sleep(50);
      }
    } catch (error) {
      // A timed-out SET may still arrive on the shared connection. Queue its matching
      // release too, so it cannot leave an orphan lease after the direct fallback.
      await command("EVAL", [release, "1", leaseKey, token]).catch(() => {});
      if (error instanceof CountRefreshBusy) throw error;
      return await boundedLoad(load);
    }
    // Renew a healthy owner's lease so a slow database cannot turn concurrent opens into a stampede.
    // Waiters share the same 30-second budget in this process and on other replicas.
    // Database statements have a matching timeout; no fabricated zero counts are returned.
    let renewing = false;
    const renewal = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void command("EVAL", [renew, "1", leaseKey, token, String(FILL_LEASE_MS)])
        .catch(() => {})
        .finally(() => {
          renewing = false;
        });
    }, FILL_LEASE_MS / 3);
    renewal.unref();
    try {
      // Another process may have completed between our GET and acquiring the lease.
      const snapshot = await read(key).catch(() => null);
      if (snapshot && Date.now() - snapshot.at < REFRESH_AFTER_MS) return snapshot.counts;
      const at = Date.now();
      const counts = await boundedLoad(load);
      const remaining = VIEW_COUNT_MAX_AGE_MS - (Date.now() - at);
      if (remaining > 0) {
        await command("EVAL", [complete, "2", key, leaseKey, token, JSON.stringify({ at, counts }), String(remaining)]).catch(() => {});
      }
      return counts;
    } finally {
      clearInterval(renewal);
      if (claimed) await command("EVAL", [release, "1", leaseKey, token]).catch(() => {});
    }
  })().finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
};

/** Call only after the current reader passed Mail's access/execution check. */
export const cachedConversationViewCounts = async (params: {
  mailboxId: string;
  reader: string;
  load: () => Promise<ConversationViewCounts>;
}): Promise<ConversationViewCounts> => {
  const [version] = await sql<[{ database: string; version: string }]>`
    SELECT current_database() AS database, COALESCE(version::text, 'initial') AS version
    FROM (SELECT 1) singleton
    LEFT JOIN mail.mailbox_read_versions ON mailbox_id = ${params.mailboxId}::uuid
  `;
  const key = `mail:view-counts:v1:${version.database}:${params.mailboxId}:${Buffer.from(params.reader).toString("base64url")}:${version.version}`;
  let snapshot: Awaited<ReturnType<typeof read>>;
  try {
    snapshot = await read(key);
  } catch {
    return waitFor(fill(key, params.load));
  }
  if (!snapshot) return waitFor(fill(key, params.load));
  if (Date.now() - snapshot.at >= REFRESH_AFTER_MS && activeLoads.size < loadLimit()) {
    void fill(key, params.load).catch((error: unknown) =>
      log.warn("Count refresh failed; the next read retries", { error: error instanceof Error ? error.message : String(error) }),
    );
  }
  return snapshot.counts;
};

/** Drain quiet fills before the application's SQL/Valkey dependencies close. */
export const stopConversationViewCountCache = async (): Promise<void> => {
  await waitFor(Promise.allSettled([...pending.values()])).catch(() => {
    log.warn("Count cache drain exceeded 30 seconds; continuing dependency shutdown");
  });
};
