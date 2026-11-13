import { expect, setSystemTime, spyOn } from "bun:test";
import { createSync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import * as logging from "../services/logging";
import { sharedText } from "./log";

const NOW = new Date("2026-11-13T00:00:00Z");
testFor("nats")(
  "lifecycle storage preserves closed fences across expansion, rollback and exhaustion",
  async () => {
    setSystemTime(NOW);
    const connection = await connectTestNats();
    const namespace = testSyncNamespace("text-lifecycle-storage");
    const sync = createSync({ connection, namespace, application: "test", defaults: { replicas: 1 } });
    bindProcessSync(sync, connection);
    const warnings: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
    const logger = spyOn(logging, "logger").mockImplementation(() => ({
      debug() {},
      info() {},
      error() {},
      warn(message, metadata) {
        warnings.push({ message, metadata });
      },
    }));
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
      const rolledBack = sharedText.define({ ...declaration, lifecycle: { maxBytes: 4096 } }).lifecycle!;
      expect(await rolledBack.get("retired")).toEqual(closed);
      expect(await rolledBack.get("active")).toEqual(frozen);
      const admitted = await rolledBack.put("another", null, { state: "open" });
      expect(await rolledBack.get("another")).toEqual(admitted);
      expect((await manager.streams.info(streams[0]!.config.name)).config.max_bytes).toBe(8192);
      expect(warnings).toEqual([
        {
          message: "Keeping the larger existing lifecycle byte budget",
          metadata: { log: "text", declaredMaxBytes: 4096, retainedMaxBytes: 8192 },
        },
      ]);
      expect(Object.keys(rolledBack).sort()).toEqual(["get", "put"]);
      expect((await manager.streams.info(streams[0]!.config.name)).state.messages).toBe(3);
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
      expect(await rolledBack.get("retired")).toEqual(closed);
    } finally {
      logger.mockRestore();
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
