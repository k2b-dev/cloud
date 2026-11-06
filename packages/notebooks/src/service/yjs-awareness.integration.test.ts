import { expect } from "bun:test";
import { bindProcessSync, unbindProcessSync } from "@k2b/cloud";
import { createSync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { createYjsAwarenessTopic, NODE_ID, type YjsAwarenessEvent } from "./yjs-sync";

// Regression for #70: JetStream rejects a stream whose duplicate window exceeds
// its max age, so the short-lived awareness topic must declare a matching window.
testFor("nats")(
  "awareness topic provisions on JetStream and delivers an event",
  async () => {
    const connection = await connectTestNats();
    const namespace = testSyncNamespace("notebooks-awareness");
    const sync = createSync({ connection, namespace, application: "notebooks", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    const live = new AbortController();
    try {
      const topic = createYjsAwarenessTopic();
      await sync.ready();
      const event: YjsAwarenessEvent = { kind: "awareness", payload: "AA==", originNodeId: NODE_ID, originPeerId: "peer" };
      // Follow from the first retained event so the outcome does not depend on
      // whether the tail attaches before or after the publish.
      const received = (async () => {
        for await (const entry of topic.follow({ after: topic.cursorAt(0), signal: live.signal })) return entry.data;
        throw new Error("follow ended before the awareness event arrived");
      })();
      await topic.publish({ data: event });
      expect(await received).toEqual(event);
    } finally {
      live.abort();
      await sync.drain();
      unbindProcessSync();
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      }
      await connection.drain();
    }
  },
  15_000,
);

// Independent runtime handles share one broker sequence, including after a
// process restart. Awareness IDs reserve the upper safe-integer range from it.
testFor("nats")(
  "awareness ID reservations remain unique across application runtimes and reconnects",
  async () => {
    const namespace = testSyncNamespace("notebooks-awareness-ids");
    const connections: Awaited<ReturnType<typeof connectTestNats>>[] = [];
    const runtimes: ReturnType<typeof createSync>[] = [];
    const reserve = async () => {
      const connection = await connectTestNats();
      connections.push(connection);
      const sync = createSync({ connection, namespace, application: "notebooks", defaults: { replicas: 1 } });
      runtimes.push(sync);
      bindProcessSync(sync);
      try {
        const topic = createYjsAwarenessTopic();
        await sync.ready();
        const result = await topic.publish({
          tenantId: "document",
          data: { kind: "awareness", payload: "AA==", originNodeId: NODE_ID, originPeerId: "reservation" },
        });
        const clientId = 2 ** 32 + result.streamSequence;
        expect(Number.isSafeInteger(clientId)).toBe(true);
        expect(clientId).toBeGreaterThan(2 ** 32);
        return clientId;
      } finally {
        unbindProcessSync();
      }
    };
    try {
      const first = await reserve();
      const second = await reserve();
      expect(second).toBeGreaterThan(first);
      // End a runtime; a fresh runtime must never reuse that connection's ID.
      await runtimes[0]!.drain();
      const reconnected = await reserve();
      expect(reconnected).toBeGreaterThan(second);
    } finally {
      unbindProcessSync();
      for (const runtime of runtimes) await runtime.drain();
      if (connections[0]) {
        const manager = await jetstreamManager(connections[0]);
        for await (const stream of manager.streams.list()) {
          if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
        }
      }
      for (const connection of connections) await connection.drain();
    }
  },
  15_000,
);
