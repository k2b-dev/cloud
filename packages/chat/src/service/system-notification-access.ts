import { type CapabilityCaller, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import { env } from "@k2b/cloud/config";
import { ratelimit } from "@k2b/cloud/server";
import { logger, toPgUuidArray } from "@k2b/cloud/services";
import { redis, sql } from "bun";
import { z } from "zod";
import { ShortIdSchema } from "./contracts";
import { ACCESS_TTL_SECONDS, RESOURCE_PAGE_SIZE } from "./resource-access";

const log = logger("chat:system-notifications");
const ReaderResult = z.object({ readable: z.array(z.uuid()).max(500) });
type ReaderInput = { id: string; container: { type: string; id: string }; userIds: string[] };
export const systemNotificationDependencies = {
  invoke: (appId: string, capabilityId: string, input: ReaderInput, caller: CapabilityCaller) =>
    invokeCapabilityWithDataSchema({ kind: "query", appId, capabilityId, input }, ReaderResult, caller),
};
// One display page (100 elements) per person, at most one full 5-page scan across all interactive traffic.
// Both precede Core admission, reserving 1,001 of Core's 1,501 requests for background checks.
export const INTERACTIVE_READER_PERSON_LIMIT = RESOURCE_PAGE_SIZE;
export const INTERACTIVE_READER_APP_LIMIT = RESOURCE_PAGE_SIZE * 5;
const personLimit = ratelimit({ id: "chat:reader-person", limit: INTERACTIVE_READER_PERSON_LIMIT, windowSecs: ACCESS_TTL_SECONDS });
const interactiveLimit = ratelimit({ id: "chat:reader-interactive", limit: INTERACTIVE_READER_APP_LIMIT, windowSecs: ACCESS_TTL_SECONDS });
const configured = () => !!(env.CLOUD_APP_CREDENTIAL && env.CLOUD_CORE_INTERNAL_ORIGIN);
const healthKey = (appId: string) => `chat:system-reader:health:${appId}`;
const CheckSchema = z.object({ ok: z.boolean(), reason: z.string().nullable(), checkedAt: z.string() });
const recordCheck = async (appId: string, ok: boolean, reason: string | null) => {
  try {
    await redis.set(healthKey(appId), JSON.stringify({ ok, reason, checkedAt: new Date().toISOString() }));
  } catch {
    log.warn("System chat reader health could not be stored");
  }
};
export const systemNotificationHealth = async () => {
  if (!configured())
    return { status: "unavailable" as const, reason: "Configure Chat's workload credential and direct Core origin", checkedAt: null };
  try {
    const checks = (await Promise.all(["spaces", "notebooks"].map((appId) => redis.get(healthKey(appId)))))
      .filter((value) => value !== null)
      .map((value) => CheckSchema.parse(JSON.parse(value)));
    const last = checks.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
    const failure = checks.find((check) => !check.ok);
    return {
      status: failure ? ("failing" as const) : last ? ("ok" as const) : ("configured" as const),
      reason: failure?.reason ?? null,
      checkedAt: failure?.checkedAt ?? last?.checkedAt ?? null,
    };
  } catch {
    return { status: "failing" as const, reason: "Reader health unavailable", checkedAt: null };
  }
};
export const reportSystemNotificationHealth = async () => {
  const health = await systemNotificationHealth();
  if (health.status === "unavailable" || health.status === "failing")
    log.warn("System chat notifications unavailable", { reason: health.reason });
};

type ReaderResource = { resource_type: string; resource_id: string; container_type: string; container_id: string };
export type SystemReaderDecision = { resource: ReaderResource | null; readable: Set<string> };
const readerResource = async (db: typeof sql, conversationId: string, threadId: string | null): Promise<ReaderResource | null> => {
  if (!threadId) return null;
  const [resource] = await db<ReaderResource[]>`
    SELECT t.resource_type, t.resource_id, c.resource_type AS container_type, c.resource_id AS container_id
    FROM chat.threads t JOIN chat.conversations c ON c.id = t.conversation_id
    WHERE t.id = ${threadId}::uuid AND c.id = ${conversationId}::uuid AND c.kind = 'system'
      AND ((c.resource_type = 'spaces.space' AND t.resource_type = 'spaces.item')
        OR (c.resource_type = 'notebooks.notebook' AND t.resource_type = 'notebooks.note'))
  `;
  return resource && ShortIdSchema.safeParse(resource.resource_id).success && ShortIdSchema.safeParse(resource.container_id).success
    ? resource
    : null;
};
const eligibleRecipients = async (db: typeof sql, conversationId: string, threadId: string | null, ids: readonly string[]) => {
  if (!ids.length || !threadId) return [];
  return db<{ id: string }[]>`
    SELECT u.id FROM auth.users u WHERE u.id = ANY(${toPgUuidArray([...ids])}::uuid[])
      AND (u.account_expires IS NULL OR u.account_expires > now())
      AND (EXISTS(SELECT 1 FROM chat.participants p WHERE p.conversation_id = ${conversationId}::uuid AND p.principal_type = 'user' AND p.principal_id = u.id)
        OR EXISTS(SELECT 1 FROM chat.thread_follows f WHERE f.thread_id = ${threadId}::uuid AND f.principal_type = 'user' AND f.principal_id = u.id))
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
  `chat:system-reader:v1:${userId}:${ref.container_type}:${ref.container_id}:${ref.resource_type}:${ref.resource_id}`;
/** Delivery never uses the cache. Interactive results (including denials) live at most 60 seconds. */
export const resolveSystemRecipients = async (
  conversationId: string,
  threadId: string | null,
  userIds: readonly string[],
  db: typeof sql = sql,
  mode: "background" | "interactive" | "cached" = "background",
): Promise<SystemReaderDecision> => {
  const ids = [...new Set(z.array(z.uuid()).max(500).parse(userIds))];
  const resource = await readerResource(db, conversationId, threadId);
  const empty = { resource, readable: new Set<string>() };
  if (!ids.length || !resource) return empty;
  if (!configured()) {
    await reportSystemNotificationHealth();
    return empty;
  }
  const candidates = await eligibleRecipients(db, conversationId, threadId, ids);
  if (!candidates.length) return empty;
  const readable = new Set<string>();
  const misses: string[] = [];
  const [appId, element] = resource.resource_type.split(".");
  const reservation = crypto.randomUUID();
  let attempted = false;
  let failureReason = `${appId}: reader check unavailable`;
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
      if ((await personLimit.check(id)).limited) {
        log.warn("System chat interactive reader admission exhausted", { scope: "person" });
        continue;
      }
      if ((await interactiveLimit.check("chat")).limited) {
        log.warn("System chat interactive reader admission exhausted", { scope: "app" });
        continue;
      }
      misses.push(id);
    }
    if (!misses.length) return { resource, readable };
    attempted = true;
    const result = await systemNotificationDependencies.invoke(
      appId!,
      `${element}.readable`,
      { id: resource.resource_id, container: { type: resource.container_type, id: resource.container_id }, userIds: misses },
      { workload: { appId: "chat" }, authorization: `Bearer ${env.CLOUD_APP_CREDENTIAL}` },
    );
    if (!result.ok) {
      failureReason = `${appId}: ${result.error.code} (${result.error.status})`;
      throw new Error("System chat reader check unavailable");
    }
    await recordCheck(appId!, true, null);
    const allowed = new Set(result.data.data.readable);
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
    return { resource, readable };
  } catch {
    if (attempted) await recordCheck(appId!, false, failureReason);
    // No exception detail: provider errors and credentials never enter logs or health text.
    log.warn("System chat reader check failed", { appId, mode });
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
): Promise<Set<string>> => (await resolveSystemRecipients(conversationId, threadId, userIds, db, mode)).readable;
