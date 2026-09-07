import { expect, test } from "bun:test";
import { createSync, type Worker } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { bindProcessSync, unbindProcessSync } from "@valentinkolb/cloud";
import { SNAPSHOT_JOB_CONFIG, yjsSnapshotWorker } from "./yjs-snapshot-worker";
import { createYjsTopic } from "./yjs-sync";

(process.env.NOTEBOOKS_NATS_TEST === "1" ? test : test.skip)(
  "snapshot ordering serializes same and different notes across competing workers",
  async () => {
    const connection = await connect({ servers: "nats://127.0.0.1:4222" });
    const namespace = `snapshot-ordering-${crypto.randomUUID()}`;
    const sync = createSync({ connection, namespace, application: "notebooks" });
    bindProcessSync(sync);
    const workers: Worker[] = [];
    const releaseFirst = Promise.withResolvers<void>();
    try {
      const job = sync.job<{ noteId: string; targetCursor: string; reason: "unload" }>(SNAPSHOT_JOB_CONFIG);
      const firstEntered = Promise.withResolvers<void>();
      const complete = Promise.withResolvers<void>();
      const firstNote = crypto.randomUUID();
      const secondNote = crypto.randomUUID();
      const seen: string[] = [];
      let active = 0;
      let maximumActive = 0;
      const handler = async ({ input }: { input: { noteId: string } }) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        seen.push(input.noteId);
        try {
          if (seen.length === 1) {
            firstEntered.resolve();
            await releaseFirst.promise;
          }
        } finally {
          active--;
          if (seen.length === 3) complete.resolve();
        }
      };
      workers.push(await job.process({ concurrency: 1 }, handler));
      workers.push(await job.process({ concurrency: 1 }, handler));
      // Exercise the real submission path, including its distinct cursor keys
      // and required note ordering key. The consumer body has no DB effects.
      await yjsSnapshotWorker.queueSnapshotSave({
        noteId: firstNote,
        targetCursor: createYjsTopic(firstNote).cursorAt(1),
        reason: "unload",
      });
      await firstEntered.promise;
      await yjsSnapshotWorker.queueSnapshotSave({
        noteId: firstNote,
        targetCursor: createYjsTopic(firstNote).cursorAt(2),
        reason: "unload",
      });
      await yjsSnapshotWorker.queueSnapshotSave({
        noteId: secondNote,
        targetCursor: createYjsTopic(secondNote).cursorAt(1),
        reason: "unload",
      });
      const manager = await jetstreamManager(connection);
      let observedPending = false;
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] !== namespace || stream.config.retention !== "workqueue") continue;
        for await (const consumer of manager.consumers.list(stream.config.name)) {
          expect(consumer.config.max_ack_pending).toBe(1);
          expect(consumer.num_ack_pending).toBe(1);
          expect(consumer.num_pending).toBe(2);
          observedPending = true;
        }
      }
      expect(observedPending).toBe(true);
      expect(seen).toEqual([firstNote]);
      releaseFirst.resolve();
      await complete.promise;
      expect(maximumActive).toBe(1);
      expect(seen).toEqual([firstNote, firstNote, secondNote]);
    } finally {
      releaseFirst.resolve();
      for (const worker of workers) worker.stop();
      await Promise.all(workers.map((worker) => worker.drain()));
      await sync.drain();
      unbindProcessSync();
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      }
      await connection.drain();
    }
  },
  30_000,
);
