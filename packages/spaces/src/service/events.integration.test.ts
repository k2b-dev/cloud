import { expect, test } from "bun:test";

const natsTest = process.env.CLOUD_SYNC_NATS_TEST === "1" ? test : test.skip;

natsTest(
  "live topic replays from an empty snapshot and fans out to independent subscribers",
  async () => {
    const { createSync } = await import("@k2b/sync");
    const { connect } = await import("@nats-io/transport-node");
    const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const connection = await connect({
      servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
      ignoreClusterUpdates: true,
      name: "spaces-topic-test",
    });
    const sync = createSync({ connection, namespace: `test-${crypto.randomUUID()}`, application: "spaces" });
    const abort = new AbortController();
    bindProcessSync(sync);
    try {
      const { latestSpaceEventCursor, liveSpaceEvents, publishSpaceEvent } = await import("./events");
      const spaceId = "11111111-1111-4111-8111-111111111111";
      const cursor = await latestSpaceEventCursor(spaceId);
      const subscribe = () => liveSpaceEvents({ spaceId, after: cursor, signal: abort.signal })[Symbol.asyncIterator]();
      await publishSpaceEvent({ type: "space.updated", spaceId }, { spaceId: "Space1" });
      expect(cursor).toMatch(/^s6t\.[A-Za-z0-9_-]+\.0$/);
      const first = subscribe();
      const second = subscribe();
      const [a, b] = await Promise.all([first.next(), second.next()]);
      if (a.done || b.done) throw new Error("Expected retained event on both subscribers");
      expect(a.value.cursor).toBe(b.value.cursor);
      expect(a.value.cursor).not.toBe(cursor);
      expect(a.value.data.public.type).toBe("space.updated");
      expect(b.value.data.public).toEqual(a.value.data.public);
      // A new tenant must start at the shared head, even if its own history is empty.
      expect(await latestSpaceEventCursor("22222222-2222-4222-8222-222222222222")).toBe(a.value.cursor);
      await first.return?.();
      await second.return?.();
    } finally {
      abort.abort();
      await sync.drain({ timeoutMs: 5_000 });
      unbindProcessSync();
      await connection.drain();
    }
  },
  30_000,
);
