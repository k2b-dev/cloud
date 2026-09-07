import { expect, test } from "bun:test";

const natsTest = process.env.CLOUD_SYNC_NATS_TEST === "1" ? test : test.skip;

natsTest(
  "live topic replays from an empty snapshot and fans out to independent subscribers",
  async () => {
    const { createSync } = await import("@k2b/sync");
    const { connect } = await import("@nats-io/transport-node");
    const { bindProcessSync, unbindProcessSync } = await import("@valentinkolb/cloud");
    const connection = await connect({
      servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
      ignoreClusterUpdates: true,
      name: "contacts-topic-test",
    });
    const sync = createSync({ connection, namespace: `test-${crypto.randomUUID()}`, application: "contacts" });
    const abort = new AbortController();
    bindProcessSync(sync);
    try {
      const { captureContactEventCursor, liveContactEvents, publishContactEvent } = await import("./events");
      const cursor = await captureContactEventCursor();
      const subscribe = () => liveContactEvents({ after: cursor, signal: abort.signal })[Symbol.asyncIterator]();
      await publishContactEvent(
        { type: "book.updated", bookId: "11111111-1111-4111-8111-111111111111" },
        { type: "book.updated", bookId: "Book01", at: new Date().toISOString() },
      );
      expect(cursor).toMatch(/^s6t\.[A-Za-z0-9_-]+\.0$/);
      const first = subscribe();
      const second = subscribe();
      const [a, b] = await Promise.all([first.next(), second.next()]);
      if (a.done || b.done) throw new Error("Expected retained event on both subscribers");
      expect(a.value.cursor).toBe(b.value.cursor);
      expect(a.value.cursor).not.toBe(cursor);
      expect(a.value.data.public.type).toBe("book.updated");
      expect(b.value.data.public).toEqual(a.value.data.public);
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
