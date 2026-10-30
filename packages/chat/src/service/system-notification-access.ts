import { readResourcePrincipals } from "@k2b/cloud/capabilities/server";
import { CloudResourceRefSchema } from "@k2b/cloud/contracts";
import { ratelimit } from "@k2b/cloud/server";
import { logger, toPgUuidArray } from "@k2b/cloud/services";
import { redis, sql } from "bun";
import { z } from "zod";
import { ACCESS_TTL_SECONDS, RESOURCE_PAGE_SIZE } from "./resource-access";

const log = logger("chat:system-notifications");
/** Only the platform owns workload authentication and admission. */
export const systemNotificationDependencies = { read: readResourcePrincipals };
// One display page (100 elements) per person, at most one full 5-page scan across all interactive traffic.
// Both precede Core admission, reserving 1,001 of Core's 1,501 requests for background checks.
export const INTERACTIVE_READER_PERSON_LIMIT = RESOURCE_PAGE_SIZE;
export const INTERACTIVE_READER_APP_LIMIT = RESOURCE_PAGE_SIZE * 5;
const personLimit = ratelimit({ id: "chat:reader-person", limit: INTERACTIVE_READER_PERSON_LIMIT, windowSecs: ACCESS_TTL_SECONDS });
const interactiveLimit = ratelimit({ id: "chat:reader-interactive", limit: INTERACTIVE_READER_APP_LIMIT, windowSecs: ACCESS_TTL_SECONDS });
export const SYSTEM_READER_HEALTH_KEY = "chat:system-reader:health:v2";
const CheckSchema = z.object({
  status: z.enum(["ok", "failing", "not_configured"]),
  reason: z.string().nullable(),
  resourceType: z.string(),
  checkedAt: z.string(),
});
const recordCheck = async (resourceType: string, status: z.infer<typeof CheckSchema>["status"], reason: string | null) => {
  try {
    await redis.set(SYSTEM_READER_HEALTH_KEY, JSON.stringify({ status, reason, resourceType, checkedAt: new Date().toISOString() }));
  } catch {
    log.warn("System chat reader health could not be stored");
  }
};
/** Report the last real platform check, without inferring readiness from configuration. */
export const systemNotificationHealth = async () => {
  try {
    const value = await redis.get(SYSTEM_READER_HEALTH_KEY);
    return value === null
      ? { status: "unchecked" as const, reason: null, resourceType: null, checkedAt: null }
      : CheckSchema.parse(JSON.parse(value));
  } catch {
    return { status: "failing" as const, reason: "health_unavailable", resourceType: null, checkedAt: null };
  }
};

type ReaderResource = { resource_type: string; resource_id: string; container_type: string; container_id: string };
export const SYSTEM_READER_VALIDITY_MS = 3_000;
export type SystemReaderDecision = { resource: ReaderResource | null; readable: Set<string>; deadline: number };
const readerResource = async (db: typeof sql, conversationId: string, threadId: string | null): Promise<ReaderResource | null> => {
  if (!threadId) return null;
  const [resource] = await db<ReaderResource[]>`
    SELECT t.resource_type, t.resource_id, c.resource_type AS container_type, c.resource_id AS container_id
    FROM chat.threads t JOIN chat.conversations c ON c.id = t.conversation_id
    WHERE t.id = ${threadId}::uuid AND c.id = ${conversationId}::uuid AND c.kind = 'system'
      AND t.resource_type IS NOT NULL AND t.resource_id IS NOT NULL
      AND c.resource_type IS NOT NULL AND c.resource_id IS NOT NULL
  `;
  return resource &&
    CloudResourceRefSchema.safeParse({ type: resource.resource_type, id: resource.resource_id }).success &&
    CloudResourceRefSchema.safeParse({ type: resource.container_type, id: resource.container_id }).success
    ? resource
    : null;
};
const eligibleRecipients = async (db: typeof sql, conversationId: string, threadId: string | null, ids: readonly string[]) => {
  if (!ids.length || !threadId) return [];
  return db<{ id: string }[]>`
    SELECT u.id FROM auth.users u WHERE u.id = ANY(${toPgUuidArray([...ids])}::uuid[])
      AND (u.account_expires IS NULL OR u.account_expires > now())
      AND (EXISTS(SELECT 1 FROM chat.participants p WHERE p.conversation_id = ${conversationId}::uuid AND p.principal_type = 'user' AND p.principal_id = u.id)
        OR EXISTS(SELECT 1 FROM chat.thread_follows f WHERE f.thread_id = ${threadId}::uuid AND f.conversation_id = ${conversationId}::uuid AND f.principal_type = 'user' AND f.principal_id = u.id))
  `;
};
/** Cheap local validation after the remote phase, safe inside the short write transaction. */
export const recheckSystemRecipients = async (
  decision: SystemReaderDecision,
  conversationId: string,
  threadId: string | null,
  db: typeof sql,
): Promise<Set<string>> => {
  const current = await readerResource(db, conversationId, threadId);
  if (
    !current ||
    !decision.resource ||
    current.resource_type !== decision.resource.resource_type ||
    current.resource_id !== decision.resource.resource_id ||
    current.container_type !== decision.resource.container_type ||
    current.container_id !== decision.resource.container_id
  )
    return new Set();
  return new Set((await eligibleRecipients(db, conversationId, threadId, [...decision.readable])).map((row) => row.id));
};
const cacheKey = (userId: string, ref: ReaderResource) =>
  `chat:system-reader:v2:${userId}:${JSON.stringify([ref.container_type, ref.container_id, ref.resource_type, ref.resource_id])}`;
/** Delivery never uses the cache. Interactive results (including denials) live at most 60 seconds. */
export const resolveSystemRecipients = async (
  conversationId: string,
  threadId: string | null,
  userIds: readonly string[],
  db: typeof sql = sql,
  mode: "background" | "interactive" | "cached" = "background",
  options: Pick<Parameters<typeof readResourcePrincipals>[0], "signal" | "locale" | "requestId"> = {},
): Promise<SystemReaderDecision> => {
  const deadline = performance.now() + SYSTEM_READER_VALIDITY_MS;
  const ids = [...new Set(z.array(z.uuid()).max(500).parse(userIds))];
  const resource = await readerResource(db, conversationId, threadId);
  const empty = { resource, readable: new Set<string>(), deadline };
  if (!ids.length || !resource) return empty;
  const candidates = await eligibleRecipients(db, conversationId, threadId, ids);
  if (!candidates.length) return empty;
  const readable = new Set<string>();
  const misses: string[] = [];
  const reserved: string[] = [];
  const reservation = crypto.randomUUID();
  let attempted = false;
  try {
    for (const { id } of candidates) {
      if (mode === "background") {
        misses.push(id);
        continue;
      }
      const key = cacheKey(id, resource);
      const cached = await redis.get(key);
      if (cached === "1") readable.add(id);
      if (cached !== null || mode === "cached") continue;
      // Reserve the cache slot atomically before admission; overlapping requests cannot amplify a miss.
      if ((await redis.send("SET", [key, reservation, "NX", "EX", String(ACCESS_TTL_SECONDS)])) !== "OK") continue;
      reserved.push(id);
      if ((await personLimit.check(id)).limited) {
        await redis.send("EVAL", [
          'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0',
          "1",
          key,
          reservation,
        ]);
        log.warn("System chat interactive reader admission exhausted", { scope: "person" });
        continue;
      }
      if ((await interactiveLimit.check("chat")).limited) {
        await redis.send("EVAL", [
          'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0',
          "1",
          key,
          reservation,
        ]);
        log.warn("System chat interactive reader admission exhausted", { scope: "app" });
        continue;
      }
      misses.push(id);
    }
    if (!misses.length) return { resource, readable, deadline };
    attempted = true;
    const signal =
      mode === "background"
        ? AbortSignal.any([
            AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))),
            ...(options.signal ? [options.signal] : []),
          ])
        : options.signal;
    const result = await systemNotificationDependencies.read({
      ...options,
      signal,
      ref: { type: resource.resource_type, id: resource.resource_id },
      container: { type: resource.container_type, id: resource.container_id },
      principals: misses.map((userId) => ({ type: "user", userId })),
    });
    signal?.throwIfAborted();
    if (mode === "background" && performance.now() >= deadline) throw new Error("System chat reader decision expired");
    if (result.state === "not_configured") {
      await recordCheck(resource.resource_type, "not_configured", result.reason);
      return empty;
    }
    await recordCheck(resource.resource_type, "ok", null);
    const allowed = new Set(result.readable.flatMap((principal) => (principal.type === "user" ? [principal.userId] : [])));
    for (const id of misses) {
      if (allowed.has(id)) readable.add(id);
      if (mode === "interactive")
        await redis.send("EVAL", [
          'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("SET", KEYS[1], ARGV[2], "KEEPTTL") end return nil',
          "1",
          cacheKey(id, resource),
          reservation,
          allowed.has(id) ? "1" : "0",
        ]);
    }
    return { resource, readable, deadline };
  } catch {
    // Cancellation releases only this request's reservations; a later request can try again.
    if (mode === "interactive") {
      try {
        for (const id of reserved)
          await redis.send("EVAL", [
            'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0',
            "1",
            cacheKey(id, resource),
            reservation,
          ]);
      } catch {
        // The reservation's TTL still bounds it when Valkey is unavailable.
      }
    }
    const cancelled =
      options.signal?.aborted && options.signal.reason instanceof DOMException && options.signal.reason.name === "AbortError";
    if (attempted && !cancelled) await recordCheck(resource.resource_type, "failing", "check_unavailable");
    // No exception detail: provider errors and credentials never enter logs or health text.
    log.warn("System chat reader check failed", { resourceType: resource.resource_type, mode });
    if (mode === "background") throw new Error("System chat reader check unavailable");
    return empty;
  }
};
export const readableSystemRecipients = async (
  conversationId: string,
  threadId: string | null,
  userIds: readonly string[],
  db: typeof sql = sql,
  mode: "background" | "interactive" | "cached" = "background",
  options: Pick<Parameters<typeof readResourcePrincipals>[0], "signal" | "locale" | "requestId"> = {},
): Promise<Set<string>> => (await resolveSystemRecipients(conversationId, threadId, userIds, db, mode, options)).readable;
