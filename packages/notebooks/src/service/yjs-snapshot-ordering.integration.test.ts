import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { bindProcessSync, unbindProcessSync } from "@k2b/cloud";
import { createSync, type Worker } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { natsServers, testFor } from "../../../../scripts/fixtures/test-infra";
import { SNAPSHOT_JOB_CONFIG, yjsSnapshotWorker } from "./yjs-snapshot-worker";
import { createYjsTopic } from "./yjs-sync";

testFor("nats")(
  "snapshot ordering serializes the same note across competing workers while other notes proceed",
  async () => {
    const connection = await connect({ servers: natsServers() });
    const namespace = `snapshot-ordering-${crypto.randomUUID()}`;
    const sync = createSync({ connection, namespace, application: "notebooks", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    const workers: Worker[] = [];
    const releaseFirst = Promise.withResolvers<void>();
    try {
      const job = sync.job<{ noteId: string; targetCursor: string; reason: "unload" }>(SNAPSHOT_JOB_CONFIG);
      const firstEntered = Promise.withResolvers<void>();
      const complete = Promise.withResolvers<void>();
      const secondStarted = Promise.withResolvers<void>();
      // The two notes must hash to different partitions (@k2b/sync places an
      // ordering key at sha256 % partitions). Sharing a partition would park
      // the second note behind the deliberately blocked first one (#42).
      const partitionOf = (noteId: string) =>
        createHash("sha256").update(noteId, "utf8").digest().readUInt32BE(0) % SNAPSHOT_JOB_CONFIG.ordering.partitions;
      const firstNote = crypto.randomUUID();
      let secondNote = crypto.randomUUID();
      while (partitionOf(secondNote) === partitionOf(firstNote)) secondNote = crypto.randomUUID();
      const seen: string[] = [];
      const finished: string[] = [];
      const handler = async ({ input }: { input: { noteId: string } }) => {
        seen.push(input.noteId);
        if (input.noteId === secondNote) secondStarted.resolve();
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
      // The idle worker was offered the same note's newer cursor before the
      // other note; once it starts the other note, it must have skipped the first.
      await secondStarted.promise;
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
