import type { SQL } from "bun";
import { z } from "zod";
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

const listeners = new Map<string, Set<() => void>>();
let active: AbortController | undefined;

/** One follower per process, released as soon as the last live connection ends. */
export const subscribeAppAccessChanged = (appId: string, changed: () => void): (() => void) => {
  let callbacks = listeners.get(appId);
  if (!callbacks) {
    callbacks = new Set();
    listeners.set(appId, callbacks);
  }
  callbacks.add(changed);
  if (!active) {
    const controller = new AbortController();
    active = controller;
    const notifyAll = () => {
      for (const callbacks of listeners.values()) for (const callback of callbacks) callback();
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
          if (parsed.success) for (const callback of listeners.get(parsed.data.appId) ?? []) callback();
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
    callbacks.delete(changed);
    if (callbacks.size === 0) listeners.delete(appId);
    if (listeners.size === 0) {
      active?.abort();
      active = undefined;
    }
  };
};
