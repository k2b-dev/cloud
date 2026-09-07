import { describe, expect, test } from "bun:test";
import { createSync } from "@k2b/sync";
import { connect } from "@nats-io/transport-node";
import { bindProcessSync, unbindProcessSync } from "../../_internal/process-sync";
import { NotificationStreamCursorSchema } from "../../contracts/notification-live";
import { notificationLive } from "./live";

const suite = process.env.SYNC_TEST_SERVERS ? describe : describe.skip;

suite("foreground notification NATS replay", () => {
  test("resumes with opaque cursors without leaking another user's events", async () => {
    const connection = await connect({ servers: process.env.SYNC_TEST_SERVERS, ignoreClusterUpdates: true });
    const sync = createSync({ connection, namespace: `notifications-test-${crypto.randomUUID()}`, application: "core" });
    bindProcessSync(sync);
    const abort = new AbortController();
    try {
      const start = notificationLive.emptyCursor();
      expect(NotificationStreamCursorSchema.safeParse(start).success).toBeTrue();
      await notificationLive.publish({ userId: "alice", eventId: "first", presentation: { title: "First" } });
      await notificationLive.publish({ userId: "bob", eventId: "private", presentation: { title: "Private" } });
      await notificationLive.publish({ userId: "alice", eventId: "second", presentation: { title: "Second" } });
      const events = notificationLive.events({ userId: "alice", after: start, signal: abort.signal })[Symbol.asyncIterator]();
      const first = await events.next();
      expect(first.value?.data.eventId).toBe("first");
      expect(NotificationStreamCursorSchema.safeParse(first.value?.cursor).success).toBeTrue();
      const resumed = notificationLive
        .events({ userId: "alice", after: first.value?.cursor, signal: abort.signal })
        [Symbol.asyncIterator]();
      expect((await resumed.next()).value?.data.eventId).toBe("second");
      const freshCursor = await notificationLive.latestCursor("carol");
      expect(freshCursor).not.toBe(start);
      await notificationLive.publish({ userId: "carol", eventId: "during-snapshot", presentation: { title: "Fresh" } });
      const fresh = notificationLive.events({ userId: "carol", after: freshCursor, signal: abort.signal })[Symbol.asyncIterator]();
      expect((await fresh.next()).value?.data.eventId).toBe("during-snapshot");
      await fresh.return?.();
      await resumed.return?.();
      await events.return?.();
    } finally {
      abort.abort();
      await sync.drain();
      unbindProcessSync();
      await connection.drain();
    }
  }, 15_000);
});
