import type { Topic, TopicConfig } from "@k2b/sync";
import { type ServerWebSocket, type SQL, sql } from "bun";
import { type Context, Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { createMiddleware } from "hono/factory";
import type { z } from "zod";
import { lazySync } from "../_internal/process-sync";
import { type AuthContext, auth } from "../server/middleware/auth";
import { rateLimit } from "../server/middleware/rate-limit";
import { logger } from "../services/logging";
import { createPgOutbox } from "../services/outbox";
import * as settings from "../services/settings";
import { publicCloudOrigin } from "../shared/app-url";
import {
  createLiveEngine,
  type LiveChannel,
  type LiveConnectionHandle,
  type LiveEngine,
  type LiveEnvelope,
  type LiveViewer,
} from "./live-engine";

export type { LiveChannel, LiveViewer } from "./live-engine";

const RECONCILE_INTERVAL_MS = 1_000;
const STALE_CHECK_INTERVAL_MS = 60_000;

/**
 * The live topic of one application. Frozen: Sync rejects a declaration that
 * differs from the existing stream, so two releases with different values
 * would break each other during a rollout. A change ships under a new id.
 */
export const liveTopicConfig = (appId: string) =>
  ({
    id: `cloud:live:${appId}`,
    owner: "cloud",
    retention: { maxAgeMs: 24 * 3_600_000, maxBytes: 64 * 1024 ** 2 },
    maxPayloadBytes: 40 * 1024,
    deadLetterRetention: { maxBytes: 1024 ** 2 },
  }) satisfies TopicConfig;

type LiveOutboxRow = { id: string; attempts: number; ordering_key: string; payload: LiveEnvelope };

const log = logger("events:live");

const liveTopics = lazySync((sync) => {
  const topics = new Map<string, Topic<LiveEnvelope>>();
  return (appId: string): Topic<LiveEnvelope> => {
    const existing = topics.get(appId);
    if (existing) return existing;
    const topic = sync.topic<LiveEnvelope>(liveTopicConfig(appId));
    topics.set(appId, topic);
    return topic;
  };
});

/** Dispatcher of one application's live rows: ordered per key, deleted once published. */
export const liveOutbox = (appId: string, publish: (row: LiveOutboxRow) => Promise<unknown>) =>
  createPgOutbox<LiveOutboxRow>({
    table: "events.outbox",
    name: `events:live:${appId}`,
    where: { kind: "live", app_id: appId },
    orderBy: "ordering_key",
    sequence: "seq",
    onDelivered: "delete",
    reconcileIntervalMs: RECONCILE_INTERVAL_MS,
    publish,
  });

/** Applications whose live updates this process defines, with the wake of their running dispatcher. */
const dispatchers = new Map<string, (() => void) | null>();
/** Live sockets served by this process; they close when the application stops. */
const engines = new Set<LiveEngine>();

/** Closes every live socket of this process with 1012, so clients reconnect to another replica. */
export const stopLiveEngines = () => {
  for (const engine of engines) engine.stop();
  engines.clear();
};

const logStaleRows = async (appId: string): Promise<void> => {
  const [row] = await sql<{ count: number; oldest_seconds: number | null }[]>`
    SELECT COUNT(*)::int AS count, EXTRACT(EPOCH FROM now() - MIN(created_at))::int AS oldest_seconds
    FROM events.outbox
    WHERE kind = 'live' AND app_id = ${appId} AND created_at < now() - interval '60 seconds'
  `;
  if (row && row.count > 0) log.warn("Live updates wait to be published", { appId, count: row.count, oldestSeconds: row.oldest_seconds });
};

/**
 * Publishes the rows of the live definitions in this process. `app.start()`
 * calls it with the started application's ID; it does nothing without a
 * definition, and fails when a definition names another application or Core
 * has not created the outbox yet.
 */
export const startLiveOutbox = async (startedAppId: string): Promise<(() => Promise<void>) | null> => {
  const appIds = [...dispatchers.keys()];
  if (appIds.length === 0) return null;
  const foreign = appIds.filter((appId) => appId !== startedAppId);
  if (foreign.length > 0) {
    throw new Error(
      `defineLive() names "${foreign.join('", "')}", but this process starts "${startedAppId}". Use the ID from the application's declaration.`,
    );
  }
  const [installed] = await sql<{ ready: boolean }[]>`
    SELECT to_regprocedure('events.enqueue(uuid,text,text,text,jsonb,text)') IS NOT NULL AS ready
  `;
  if (!installed?.ready) {
    throw new Error(
      `"${appIds.join('", "')}" writes live updates to events.outbox, which does not exist. Update Cloud Core first: its migration creates the outbox.`,
    );
  }
  const stops = appIds.map((appId) => {
    const topic = liveTopics()(appId);
    const outbox = liveOutbox(appId, (row) => topic.publish({ data: row.payload, orderingKey: row.ordering_key, idempotencyKey: row.id }));
    outbox.start();
    dispatchers.set(appId, () => void outbox.notify());
    const staleCheck = setInterval(() => {
      logStaleRows(appId).catch((error) =>
        log.warn("Live outbox check failed", { appId, error: error instanceof Error ? error.message : String(error) }),
      );
    }, STALE_CHECK_INTERVAL_MS);
    staleCheck.unref();
    return async () => {
      clearInterval(staleCheck);
      dispatchers.set(appId, null);
      await outbox.stop();
    };
  });
  return async () => {
    stopLiveEngines();
    await Promise.all(stops.map((stop) => stop()));
  };
};

const viewerOf = <Env extends AuthContext>(c: Context<Env>): LiveViewer => {
  const accessSubject = c.get("accessSubject");
  return {
    id: accessSubject.type === "user" ? `user:${accessSubject.userId}` : `service_account:${accessSubject.serviceAccountId}`,
    actor: c.get("actor"),
    accessSubject,
    scopes: c.get("credentialScopes") ?? [],
  };
};

type ProbeEnv = AuthContext & { Bindings: { found: (viewer: LiveViewer) => void } };

/** The ordinary credential check of every API request, run again for an open socket. */
const probe = new Hono<ProbeEnv>()
  .onError((error) => {
    throw error;
  })
  .get("*", auth.requireRole("authenticated"), (c) => {
    c.env.found(viewerOf(c));
    return c.body(null, 204);
  });

/** Checks the socket's credential again: `null` once the session or token is no longer valid. */
const revalidator = (c: Context<AuthContext>) => {
  const headers = new Headers();
  for (const name of ["cookie", "authorization"]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  const path = c.req.path;
  return async (): Promise<LiveViewer | null> => {
    let viewer: LiveViewer | null = null;
    await probe.request(path, { headers }, { found: (found: LiveViewer) => (viewer = found) });
    return viewer;
  };
};

/** A session cookie travels with every page of the browser, so its socket must come from Cloud's own origin. */
const requireCloudOrigin = createMiddleware<AuthContext>(async (c, next) => {
  if (c.get("credentialKind") !== "session") return next();
  const origin = c.req.header("Origin");
  if (origin && origin === publicCloudOrigin(await settings.get<string>("app.url"))) return next();
  return c.json({ code: "FORBIDDEN", message: "Live sockets signed in with a session must come from the Cloud origin" }, 403);
});

/**
 * Live updates of one application: hints, optionally with data, for its own
 * open tabs. Define them once at module scope; `app.start()` then publishes the
 * rows that `publish()` writes, and `routes()` serves them to browsers.
 * `appId` is required and must be the ID that the process starts; it is never
 * derived from the process.
 */
export const defineLive = <const Event extends z.ZodType>(definition: { appId: string; event: Event }) => {
  const { appId, event } = definition;
  if (!dispatchers.has(appId)) dispatchers.set(appId, null);
  return {
    /**
     * Writes one update in `tx`, the transaction that makes the change: a
     * rollback writes nothing, a commit publishes it at least once. Data above
     * 32 KiB becomes a reload hint for `key`; `data` must not hold anything a
     * reader of `key` may not see. `access: true` announces that who may read
     * `key` changed: every replica checks its subscribers of `key` and its
     * collections again before it delivers the update.
     */
    publish: async (
      tx: SQL,
      input: { key: string; data: z.input<Event>; access?: true } | { key: string; data?: undefined; access: true },
    ): Promise<void> => {
      // Store the JSON form of the input, and validate exactly that form here:
      // the browser parses it, and data that does not survive JSON fails this write.
      const data: unknown = input.data === undefined ? undefined : JSON.parse(JSON.stringify(input.data));
      if (data !== undefined) event.parse(data);
      const envelope = JSON.stringify({ v: 1, k: input.key, d: data, a: input.access });
      await tx`SELECT events.enqueue(${crypto.randomUUID()}::uuid, ${appId}, 'live', ${input.key}, ${envelope}::text::jsonb)`;
    },
    /** Publishes committed updates now instead of within the next second. Call it after the commit. */
    wake: (): void => dispatchers.get(appId)?.(),
    /** The topic head. Read it before loading the snapshot it belongs to. */
    cursor: (): Promise<string> => liveTopics()(appId).head(),
    /**
     * The live socket with these channels. Mount it once, at `/api/<app>/live`.
     * It authenticates like any API request; a session needs the Cloud origin
     * and an OAuth token the `read` scope. Channels are passed here, not to
     * `defineLive()`, because they check access with the domain services that
     * themselves publish updates.
     */
    routes: <const Scopes extends Record<string, z.ZodType>>(channels: { [Name in keyof Scopes]: LiveChannel<Scopes[Name]> }) => {
      let engine: LiveEngine | null = null;
      const serve = (): LiveEngine => {
        if (engine && engines.has(engine)) return engine;
        engine = createLiveEngine({ appId, topic: () => liveTopics()(appId), channels });
        engines.add(engine);
        return engine;
      };
      return new Hono<AuthContext>().get(
        "/",
        rateLimit({ limitPerSecond: 5 }),
        auth.requireRole("authenticated"),
        requireCloudOrigin,
        auth.requireOAuthScope("read", "admin"),
        upgradeWebSocket((c) => {
          const viewer = viewerOf(c);
          const revalidate = revalidator(c);
          let connection: LiveConnectionHandle | null = null;
          return {
            onOpen: (_event, ws) => {
              connection = serve().open(ws.raw as ServerWebSocket<unknown>, viewer, revalidate);
            },
            onMessage: (message) => connection?.message(message.data),
            onClose: () => connection?.closed(),
          };
        }),
      );
    },
  };
};
