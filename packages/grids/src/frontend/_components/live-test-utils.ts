import { mock } from "bun:test";
import type { LiveSubscriptionHandlers } from "@k2b/cloud/browser/live";

/** One subscription the code under test opened, driven by the test instead of a socket. */
export type FakeLiveSubscription = {
  url: string;
  channel: string;
  scope: unknown;
  cursor: string | null;
  closed: boolean;
  /** Delivers updates the way the socket does: parsed, then applied as one batch. */
  deliver: (data: unknown[]) => Promise<void>;
  resync: () => Promise<void>;
  revoke: (code: "not_found" | "access_denied") => void;
  /** Live updates stopped for good. */
  fail: () => void;
};

/**
 * Replaces `liveConnection` for this test file. Call it before importing the
 * code under test; the returned list fills as that code subscribes.
 */
export const fakeLiveConnection = (): FakeLiveSubscription[] => {
  const subscriptions: FakeLiveSubscription[] = [];
  let cursor = 0;
  mock.module("@k2b/cloud/browser/live", () => ({
    liveConnection: (url: string) => ({
      subscribe: <T>(channel: string, scope: unknown, handlers: LiveSubscriptionHandlers<T>) => {
        const subscription: FakeLiveSubscription = {
          url,
          channel,
          scope,
          cursor: handlers.cursor,
          closed: false,
          deliver: (data) => handlers.apply(data.map((item) => ({ data: handlers.parse(item), cursor: `s6t.test.${++cursor}` }))),
          resync: handlers.resync,
          revoke: (code) => handlers.revoked?.(code),
          fail: handlers.unavailable,
        };
        subscriptions.push(subscription);
        return {
          close: () => {
            subscription.closed = true;
          },
        };
      },
    }),
  }));
  return subscriptions;
};
