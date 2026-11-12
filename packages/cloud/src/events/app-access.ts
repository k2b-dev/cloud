import type { SQL } from "bun";
import { z } from "zod";
import { sql } from "../runtime/clients";
import { invalidateIdentityRuntimeConfig } from "../services/identity/runtime-config";
import { logger } from "../services/logging";
import { superviseRuntimeTask } from "../services/runtime-lifecycle";
import { defineLivePublisher, liveTopic } from "./live-delivery";

const change = z.object({ type: z.literal("app.access.changed"), appId: z.string() });
// Core already owns and publishes this topic and outbox; no second delivery mechanism.
const changes = defineLivePublisher({ appId: "core", event: change });

/** Call in the grant/state mutation transaction; rolled-back changes publish nothing. */
export const publishAppAccessChanged = (tx: SQL, appId: string): Promise<void> =>
  changes.publish(tx, { key: `app.access:${appId}`, data: { type: "app.access.changed", appId }, access: true });
export const wakeAppAccessChanged = (): void => changes.wake();

export type IdentityAccessSubject = { userId?: string | null; sid?: string | null; serviceAccountId?: string | null };
const identityChange = z.object({
  type: z.literal("identity.access.changed"),
  userId: z.string().nullish(),
  sid: z.string().nullish(),
  serviceAccountId: z.string().nullish(),
});
type Listener = { changed(): void; subject?: IdentityAccessSubject };
const listeners = new Map<string, Set<Listener>>();
export const identityAccessAffects = (event: IdentityAccessSubject, subject: IdentityAccessSubject): boolean =>
  (!event.userId || event.userId === subject.userId) &&
  (!event.sid || !subject.sid || event.sid === subject.sid) &&
  (!event.serviceAccountId || event.serviceAccountId === subject.serviceAccountId);
let active: AbortController | undefined;

/** One follower per process, released as soon as the last live connection ends. */
export const subscribeAppAccessChanged = (appId: string, changed: () => void, subject?: IdentityAccessSubject): (() => void) => {
  let callbacks = listeners.get(appId);
  if (!callbacks) {
    callbacks = new Set();
    listeners.set(appId, callbacks);
  }
  const listener = { changed, subject };
  callbacks.add(listener);
  if (!active) {
    const controller = new AbortController();
    active = controller;
    const notifyAll = () => {
      invalidateIdentityRuntimeConfig();
      for (const callbacks of listeners.values()) for (const callback of callbacks) callback.changed();
    };
    void superviseRuntimeTask({
      name: "App access invalidations",
      signal: controller.signal,
      run: async (signal) => {
        const source = liveTopic("core");
        const after = await source.head();
        if (signal.aborted) return;
        // Recheck after capturing the cursor to cover changes during subscription startup/reconnect.
        notifyAll();
        for await (const event of source.follow({ after, signal })) {
          const parsed = change.safeParse(event.data.d);
          if (parsed.success) for (const callback of listeners.get(parsed.data.appId) ?? []) callback.changed();
          else {
            const identity = identityChange.safeParse(event.data.d);
            if (!identity.success) continue;
            if (!identity.data.userId && !identity.data.sid && !identity.data.serviceAccountId) invalidateIdentityRuntimeConfig();
            for (const callbacks of listeners.values())
              for (const callback of callbacks)
                if (!callback.subject || identityAccessAffects(identity.data, callback.subject)) callback.changed();
          }
        }
      },
      onError: ({ error }) => {
        notifyAll();
        logger("app-access").warn("App access invalidations failed; reconnecting", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    }).finally(() => {
      if (active === controller) active = undefined;
    });
  }
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    callbacks.delete(listener);
    if (callbacks.size === 0) listeners.delete(appId);
    if (listeners.size === 0) {
      active?.abort();
      active = undefined;
    }
  };
};

/** Deferred rows use the existing retry gate so older dispatchers also honor the deadline.
 * Replace one future invalidation; delivery uses Core's existing outbox, never a socket timer. */
export const scheduleSessionIdleAccessChanged = async (tx: SQL, sid: string, timeoutSeconds: number): Promise<void> => {
  const key = `identity.deadline.idle:${sid}`;
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  await tx`DELETE FROM events.outbox WHERE app_id = 'core' AND kind = 'live' AND ordering_key = ${key}`;
  // Derive the absolute deadline from the family, not a remaining duration read
  // earlier by authentication: a delayed request must not extend the idle limit.
  const [family] = await tx<
    { deadline: string; user_id: string }[]
  >`SELECT user_id, (last_input_at + ${timeoutSeconds} * interval '1 second')::text AS deadline
    FROM auth.session_families WHERE sid = ${sid}::uuid AND last_input_at IS NOT NULL AND revoked_at IS NULL`;
  if (!family) return;
  const id = crypto.randomUUID();
  await tx`SELECT events.enqueue(${id}::uuid, 'core', 'live', ${key}, ${JSON.stringify({ v: 1, k: key, d: { type: "identity.access.changed", userId: family.user_id, sid } })}::text::jsonb)`;
  await tx`UPDATE events.outbox SET attempts = 1, next_attempt_at = GREATEST(clock_timestamp(), ${family.deadline}::timestamptz) WHERE id = ${id}::uuid`;
};

/** Identity/group/session mutations and deadline events, on Core's existing shared live follower. */
export const subscribeIdentityAccessChanged = (changed: () => void, subject?: IdentityAccessSubject): (() => void) =>
  subscribeAppAccessChanged("*", changed, subject);

/** Run once during lifecycle.start before accepting event-only authenticated rooms. */
export const requireIdentityAccessEvents = async (): Promise<void> => {
  const [row] = await sql<{ ready: boolean }[]>`SELECT to_regprocedure('auth.publish_room_identity(jsonb)') IS NOT NULL AS ready`;
  if (!row?.ready) throw new Error("Event-only rooms require Core identity access sources; upgrade and start Core before this application");
};
