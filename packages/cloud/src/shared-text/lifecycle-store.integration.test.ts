import { expect, setSystemTime } from "bun:test";
import { createSync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import { sharedText } from "./log";

const NOW = new Date("2026-11-13T00:00:00Z");
testFor("nats")(
  "lifecycle storage expands without losing fences, rejects shrinking, and forgets only completed retirement",
  async () => {
    setSystemTime(NOW);
    const connection = await connectTestNats();
    const namespace = testSyncNamespace("text-lifecycle-storage");
    const sync = createSync({ connection, namespace, application: "test", defaults: { replicas: 1 } });
    bindProcessSync(sync, connection);
    try {
      const declaration = { id: "text", whenFull: "reject", retention: { maxBytes: 1024 * 1024 } } as const;
      const first = sharedText.define({ ...declaration, lifecycle: { maxBytes: 4096 } }).lifecycle!;
      const closed = await first.put("retired", null, {
        state: "closed",
        freezeCursor: "freeze",
        closeCursor: "close",
        restoreRevision: "0",
      });
      const frozen = await first.put("active", null, {
        state: "frozen",
        freezeCursor: "freeze-active",
        expiresAt: NOW.getTime() + 60_000,
        restoreRevision: "0",
      });
      const expanded = sharedText.define({ ...declaration, lifecycle: { maxBytes: 8192 } }).lifecycle!;
      expect(await expanded.get("retired")).toEqual(closed);
      expect(await expanded.get("active")).toEqual(frozen);
      const manager = await jetstreamManager(connection);
      const streams = [];
      for await (const stream of manager.streams.list())
        if (stream.config.metadata?.["cloud.shared-text.lifecycle"] === "text" && stream.config.metadata?.["sync.namespace"] === namespace)
          streams.push(stream);
      expect(streams).toHaveLength(1);
      expect(streams[0]!.config.max_bytes).toBe(8192);
      expect(streams[0]!.config.num_replicas).toBe(1);
      expect(streams[0]!.state.messages).toBe(2);
      const shrinking = sharedText.define({ ...declaration, lifecycle: { maxBytes: 4096 } }).lifecycle!;
      await expect(shrinking.get("retired")).rejects.toThrow("cannot be decreased");
      await expect(expanded.forget("active")).rejects.toThrow("Only a completed, retired close");
      const preparingClose = await expanded.put("preparing-close", null, {
        state: "closed",
        freezeCursor: "freeze-pending",
        closeCursor: null,
        restoreRevision: "0",
      });
      await expect(expanded.forget("preparing-close")).rejects.toThrow("Only a completed, retired close");
      await expanded.put("preparing-close", preparingClose, {
        state: "closed",
        freezeCursor: "freeze-pending",
        closeCursor: "close-pending",
        restoreRevision: "0",
      });
      await expanded.forget("preparing-close");
      await expanded.forget("retired");
      await expanded.forget("retired");
      expect(await first.get("retired")).toBeNull(); // The original handle's decoded cache cannot resurrect it.
      expect(await expanded.get("active")).toEqual(frozen);
      expect((await manager.streams.info(streams[0]!.config.name)).state.messages).toBe(1);
      // A full store rejects another entry without evicting any existing fence.
      let full: unknown;
      for (let index = 0; index < 100 && !full; index++) {
        try {
          await expanded.put(`retired-${index}`, null, closed.value);
        } catch (error) {
          full = error;
        }
      }
      expect(full).toBeDefined();
      expect(await expanded.get("active")).toEqual(frozen);
    } finally {
      unbindProcessSync();
      await sync.drain();
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list())
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      await connection.drain();
      setSystemTime();
    }
  },
  30_000,
);
