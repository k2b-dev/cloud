import { expect } from "bun:test";
import { bindProcessSync, unbindProcessSync } from "@k2b/cloud";
import { createSync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { natsServers, testFor } from "../../../../scripts/fixtures/test-infra";
import { createYjsAwarenessTopic, NODE_ID, type YjsAwarenessEvent } from "./yjs-sync";

// Regression for #70: JetStream rejects a stream whose duplicate window exceeds
// its max age, so the short-lived awareness topic must declare a matching window.
testFor("nats")(
  "awareness topic provisions on JetStream and delivers an event",
  async () => {
    const connection = await connect({ servers: natsServers() });
    const namespace = `notebook-awareness-${crypto.randomUUID()}`;
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
