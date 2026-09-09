import { expect, test } from "bun:test";
import { createSync, type Worker } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { bindProcessSync, unbindProcessSync } from "@k2b/cloud";
import { SNAPSHOT_JOB_CONFIG, yjsSnapshotWorker } from "./yjs-snapshot-worker";
import { createYjsTopic } from "./yjs-sync";

(process.env.NOTEBOOKS_NATS_TEST === "1" ? test : test.skip)(
  "snapshot ordering serializes the same note across competing workers while other notes proceed",
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
      const finished: string[] = [];
      const handler = async ({ input }: { input: { noteId: string } }) => {
        seen.push(input.noteId);
        try {
          if (seen.length === 1) {
            firstEntered.resolve();
            await releaseFirst.promise;
          }
        } finally {
          finished.push(input.noteId);
          if (finished.length === 3) complete.resolve();
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
      // Give the idle worker time to pick up anything the broker offers: the
      // other note may start, the same note's newer cursor must not.
      await Bun.sleep(2_000);
      const manager = await jetstreamManager(connection);
      let partitionConsumers = 0;
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] !== namespace || stream.config.retention !== "workqueue") continue;
        for await (const consumer of manager.consumers.list(stream.config.name)) {
          expect(consumer.config.max_ack_pending).toBe(1);
          partitionConsumers++;
        }
      }
      expect(partitionConsumers).toBe(8);
      expect(seen.filter((noteId) => noteId === firstNote)).toEqual([firstNote]);
      releaseFirst.resolve();
      await complete.promise;
      expect(seen.filter((noteId) => noteId === firstNote)).toEqual([firstNote, firstNote]);
      expect(seen).toContain(secondNote);
      // The same note's second snapshot started only after its first one finished.
      expect(seen.lastIndexOf(firstNote)).toBeGreaterThan(finished.indexOf(firstNote));
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
