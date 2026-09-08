import { expect, test } from "bun:test";
import { sql } from "bun";

const syncTest = process.env.PULSE_SYNC_NATS_TEST === "1" ? test : test.skip;

syncTest(
  "a coalesced deletion runs through NATS and keeps one observed span with its summary",
  async () => {
    const { createSync } = await import("@k2b/sync");
    const { connect } = await import("@nats-io/transport-node");
    const { bindProcessSync, unbindProcessSync } = await import("@valentinkolb/cloud");
    const { observeSyncEvent } = await import("@valentinkolb/cloud/services/logging/trace");
    const { startPulseBaseJobs, submitBaseDeletionJob, stopPulseBaseDeletionJob, stopPulseBaseDataClearJob } = await import(
      "./base-lifecycle"
    );
    const { newShortId } = await import("../lib/short-id");
    const { migrate } = await import("../migrate");
    await migrate();
    const connection = await connect({
      servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
      ignoreClusterUpdates: true,
      name: "pulse-deletion-test",
    });
    const namespace = `pulse-test-${crypto.randomUUID()}`;
    const sync = createSync({ connection, namespace, application: "pulse", observe: observeSyncEvent });
    const baseId = crypto.randomUUID();
    const publicBaseId = newShortId();
    bindProcessSync(sync);
    try {
      await sql`INSERT INTO pulse.bases (id, short_id, name, deletion_started_at) VALUES (${baseId}::uuid, ${publicBaseId}, 'Sync lifecycle test', now())`;
      // Queue duplicate recovery submissions before starting either worker.
      await submitBaseDeletionJob(baseId, publicBaseId);
      await submitBaseDeletionJob(baseId, publicBaseId);
      await startPulseBaseJobs();
      const deadline = Date.now() + 20_000;
      let complete = false;
      while (Date.now() < deadline) {
        const [state] = await sql<Array<{ exists: boolean; spans: number; summarized: number }>>`
        SELECT EXISTS (SELECT 1 FROM pulse.bases WHERE id = ${baseId}::uuid) AS exists,
          COUNT(*)::int AS spans,
          COUNT(*) FILTER (WHERE summary->>'done' = 'true')::int AS summarized
        FROM logging.trace_spans
        WHERE source = 'pulse:base-delete' AND attributes->>'cloud.pulse.base_id' = ${publicBaseId}
      `;
        if (state && !state.exists && state.summarized > 0) {
          expect(state.spans).toBe(1);
          expect(state.summarized).toBe(1);
          complete = true;
          break;
        }
        await Bun.sleep(50);
      }
      expect(complete).toBe(true);
    } finally {
      await stopPulseBaseDeletionJob();
      await stopPulseBaseDataClearJob();
      await sync.drain({ timeoutMs: 5_000 });
      unbindProcessSync();
      try {
        // JetStream is owned by Sync; resolve its client through that package.
        const {
          jetstreamManager,
        }: {
          jetstreamManager(client: typeof connection): Promise<{
            streams: {
              list(): AsyncIterable<{ config: { name: string; metadata?: Record<string, string> } }>;
              delete(name: string): Promise<boolean>;
            };
          }>;
        } = await import(Bun.resolveSync("@nats-io/jetstream", new URL(".", import.meta.resolve("@k2b/sync")).pathname));
        const manager = await jetstreamManager(connection);
        for await (const stream of manager.streams.list()) {
          if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
        }
      } finally {
        await connection.drain();
        await sql`DELETE FROM pulse.bases WHERE id = ${baseId}::uuid`;
        await sql`DELETE FROM logging.trace_spans WHERE source = 'pulse:base-delete' AND attributes->>'cloud.pulse.base_id' = ${publicBaseId}`;
      }
    }
  },
  30_000,
);
