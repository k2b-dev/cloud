import { createHash, randomBytes } from "node:crypto";
import { type BrowserPushSubscription, BrowserPushSubscriptionSchema } from "@k2b/cloud/contracts/user-notifications";
import { sendPinnedWebPush } from "@k2b/cloud/services/notifications/web-push-transport";
import type { Queue, QueueConfig, QueueMessage, Sync } from "@k2b/sync";
import { type SQL, sql } from "bun";
import type { RequestOptions as WebPushOptions } from "web-push";
import { z } from "zod";

/**
 * One budget window equals the five-minute lifetime of a Cloud sign-in request
 * (`APP_APPROVAL_LIMITS.loginSeconds`): a wake-up older than that is useless.
 */
export const PUSH_LIMITS = {
  windowSeconds: 300,
  /** Five pending sign-ins per account and Cloud, for six accounts on one phone. */
  notificationsPerToken: 30,
  /** About ten wake-ups per second from one Cloud or NAT address. */
  requestsPerCaller: 3_000,
  subscriptionsPerCaller: 30,
  subscriptionBodyBytes: 4_096,
  notifyBodyBytes: 1_024,
} as const;

export const PushTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const CloudOriginSchema = z
  .string()
  .max(256)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.origin === value && (url.protocol === "https:" || (url.protocol === "http:" && loopback.has(url.hostname)));
    } catch {
      return false;
    }
  }, "must be an http(s) origin");
export const NotifySchema = z
  .object({ token: PushTokenSchema, cloudOrigin: CloudOriginSchema, requestRef: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })
  .strict();
export const TestSchema = z.object({ token: PushTokenSchema }).strict();
export const SubscriptionSchema = BrowserPushSubscriptionSchema.strict();

/** The encrypted message the service worker receives. It is a wake-up, never an instruction. */
export type PushMessage = { v: 1; type: "login"; cloud: string; ref: string } | { v: 1; type: "test" };
type Delivery = { subscriptionId: string; message: PushMessage };
type Row = { id: string; endpoint: string; p256dh: string; auth: string; expires_at: Date | null };
export type Vapid = { subject: string; publicKey: string; privateKey: string };
export type PushSender = (subscription: BrowserPushSubscription, payload: string, options: WebPushOptions) => Promise<void>;
export type RateLimited = { retryAfter: number };

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const statusOf = (error: unknown) =>
  error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : null;

export const migrate = async (db: SQL = sql) => {
  // Replicas may start together; one migrates while the others wait.
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('cloud_login:migrate', 0))`;
    await tx`CREATE SCHEMA IF NOT EXISTS cloud_login`;
    await tx`
      CREATE TABLE IF NOT EXISTS cloud_login.push_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token_hash TEXT NOT NULL UNIQUE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_success_at TIMESTAMPTZ,
        failure_count INT NOT NULL DEFAULT 0
      )`;
    await tx`
      CREATE TABLE IF NOT EXISTS cloud_login.push_rate_limits (
        key TEXT PRIMARY KEY,
        window_start TIMESTAMPTZ NOT NULL,
        hits INT NOT NULL
      )`;
    await tx`CREATE INDEX IF NOT EXISTS push_rate_limits_window ON cloud_login.push_rate_limits(window_start)`;
  });
};

export const pushQueueConfig = {
  id: "cloud-login-push",
  // A few quick retries inside the sign-in lifetime; then the dead-letter queue.
  delivery: { maxAttempts: 4, backoffMs: [2_000, 10_000, 30_000], ackWaitMs: 30_000, maxInFlight: 256 },
  retention: { maxAgeMs: 60 * 60_000, maxBytes: 64 * 1024 * 1024 },
  dedupeWindowMs: PUSH_LIMITS.windowSeconds * 1000,
  maxPayloadBytes: 4_096,
} satisfies QueueConfig;

export const createPushService = (options: {
  sync: Sync;
  vapid: Vapid;
  db?: SQL;
  send?: PushSender;
  queue?: Partial<QueueConfig>;
  limits?: Partial<Record<keyof typeof PUSH_LIMITS, number>>;
}) => {
  const db = options.db ?? sql;
  const send = options.send ?? sendPinnedWebPush;
  const limits: Record<keyof typeof PUSH_LIMITS, number> = { ...PUSH_LIMITS, ...options.limits };
  const queue: Queue<Delivery> = options.sync.queue<Delivery>({ ...pushQueueConfig, ...options.queue });

  /** Fixed-window counter shared by all replicas. Keys are hashed; no address is stored. */
  const hit = async (key: string, limit: number): Promise<RateLimited | null> => {
    const window = limits.windowSeconds;
    const [row] = await db<{ hits: number; retry_after: number }[]>`
      INSERT INTO cloud_login.push_rate_limits AS r (key, window_start, hits)
      VALUES (${hash(key)}, to_timestamp(floor(extract(epoch FROM now()) / ${window}) * ${window}), 1)
      ON CONFLICT (key) DO UPDATE SET
        hits = CASE WHEN r.window_start = EXCLUDED.window_start THEN r.hits + 1 ELSE 1 END,
        window_start = EXCLUDED.window_start
      RETURNING hits, ceil(extract(epoch FROM window_start + ${window} * interval '1 second' - now()))::int AS retry_after`;
    return row && row.hits > limit ? { retryAfter: Math.max(1, row.retry_after) } : null;
  };

  const find = async (token: string) => {
    const [row] = await db<Row[]>`SELECT * FROM cloud_login.push_subscriptions WHERE token_hash = ${hash(token)}`;
    if (row?.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      await db`DELETE FROM cloud_login.push_subscriptions WHERE id = ${row.id}::uuid`;
      return undefined;
    }
    return row;
  };

  const enqueue = async (token: string, message: PushMessage): Promise<"queued" | "gone" | RateLimited> => {
    const row = await find(token);
    if (!row) return "gone";
    const limited = await hit(`token:${row.id}`, limits.notificationsPerToken);
    if (limited) return limited;
    await queue.send({
      data: { subscriptionId: row.id, message },
      // The same sign-in request wakes a phone once, however often a Cloud retries.
      idempotencyKey: message.type === "login" ? hash(JSON.stringify([row.id, message.cloud, message.ref])) : undefined,
      ttlMs: limits.windowSeconds * 1000,
    });
    return "queued";
  };

  const deliver = async ({ data, attempt, publishedAt }: QueueMessage<Delivery>) => {
    if (Date.now() - publishedAt.getTime() > limits.windowSeconds * 1000) return;
    const [row] = await db<Row[]>`SELECT * FROM cloud_login.push_subscriptions WHERE id = ${data.subscriptionId}::uuid`;
    if (!row) return;
    const cloud = data.message.type === "login" ? data.message.cloud : "test";
    try {
      await send(
        { endpoint: row.endpoint, expirationTime: null, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(data.message),
        {
          TTL: limits.windowSeconds,
          urgency: "high",
          // A newer wake-up for the same Cloud replaces an undelivered older one.
          topic: createHash("sha256").update(cloud).digest("base64url").slice(0, 32),
          vapidDetails: options.vapid,
        },
      );
    } catch (error) {
      const status = statusOf(error);
      if (status === 404 || status === 410) {
        await db`DELETE FROM cloud_login.push_subscriptions WHERE id = ${row.id}::uuid`;
        return;
      }
      // Everything else is retried with backoff; the last attempt moves to the
      // dead-letter queue. A wrong VAPID key must not delete subscriptions.
      if (attempt >= (options.queue?.delivery?.maxAttempts ?? pushQueueConfig.delivery.maxAttempts))
        await db`UPDATE cloud_login.push_subscriptions SET failure_count = failure_count + 1 WHERE id = ${row.id}::uuid`;
      throw new Error(status === null ? "Push service unreachable" : `Push service answered ${status}`);
    }
    await db`UPDATE cloud_login.push_subscriptions SET last_success_at = now(), failure_count = 0 WHERE id = ${row.id}::uuid`;
  };

  return {
    queue,
    publicKey: options.vapid.publicKey,
    limits,
    hit,
    subscribe: async (subscription: z.infer<typeof SubscriptionSchema>) => {
      const token = randomBytes(32).toString("base64url");
      const expires = subscription.expirationTime ? new Date(subscription.expirationTime) : null;
      // Re-subscribing the same endpoint rotates its token: the previous one stops working.
      await db`
        INSERT INTO cloud_login.push_subscriptions (token_hash, endpoint, p256dh, auth, expires_at)
        VALUES (${hash(token)}, ${subscription.endpoint}, ${subscription.keys.p256dh}, ${subscription.keys.auth}, ${expires})
        ON CONFLICT (endpoint) DO UPDATE SET token_hash = EXCLUDED.token_hash, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
          expires_at = EXCLUDED.expires_at, created_at = now(), last_success_at = NULL, failure_count = 0`;
      return token;
    },
    unsubscribe: async (token: string) => {
      await db`DELETE FROM cloud_login.push_subscriptions WHERE token_hash = ${hash(token)}`;
    },
    notify: (input: z.infer<typeof NotifySchema>) =>
      enqueue(input.token, { v: 1, type: "login", cloud: input.cloudOrigin, ref: input.requestRef }),
    test: (token: string) => enqueue(token, { v: 1, type: "test" }),
    deliver,
    /** Bounded maintenance: expired windows only, a batch at a time. */
    prune: async () => {
      await db`DELETE FROM cloud_login.push_rate_limits WHERE key IN (
        SELECT key FROM cloud_login.push_rate_limits WHERE window_start < now() - ${limits.windowSeconds * 2} * interval '1 second'
        ORDER BY window_start LIMIT 1000 FOR UPDATE SKIP LOCKED)`;
    },
    start: (signal?: AbortSignal) => queue.process({ concurrency: 16, signal }, deliver),
  };
};
export type PushService = ReturnType<typeof createPushService>;
