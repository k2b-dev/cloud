import { describe, expect, test } from "bun:test";
import { createSync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { bindProcessSync, unbindProcessSync } from "@valentinkolb/cloud";
import { join, leave, snapshot } from "./presence";

describe("notebook presence", () => {
  (process.env.NOTEBOOKS_NATS_TEST === "1" ? test : test.skip)("preserves avatar identity while deduplicating a user's peers", async () => {
    const connection = await connect({ servers: "nats://127.0.0.1:4222" });
    const namespace = `notebook-presence-${crypto.randomUUID()}`;
    const sync = createSync({ connection, namespace, application: "notebooks" });
    bindProcessSync(sync);
    const noteId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const peers = [crypto.randomUUID(), crypto.randomUUID()];

    try {
      await join({
        noteId,
        peerId: peers[0]!,
        userId,
        displayName: "Ada Lovelace",
        avatarHash: "old-avatar-revision",
      });
      await join({
        noteId,
        peerId: peers[1]!,
        userId,
        displayName: "Ada Lovelace",
        avatarHash: "avatar-revision",
      });

      const state = await snapshot({ noteId });
      expect(state.participants).toHaveLength(1);
      expect(state.participants[0]).toMatchObject({
        userId,
        displayName: "Ada Lovelace",
        avatarHash: "avatar-revision",
        peerCount: 2,
      });
    } finally {
      await Promise.all(peers.map((peerId) => leave({ noteId, peerId, reason: "test cleanup" })));
      await sync.drain();
      unbindProcessSync();
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      }
      await connection.drain();
    }
  });
});
