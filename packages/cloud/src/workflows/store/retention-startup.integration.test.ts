import { expect } from "bun:test";
import { type ReservedSQL, SQL } from "bun";
import { createDisposableDatabase, requireInfra, testFor } from "../../../../../scripts/fixtures/test-infra";
import { ensureWorkflowEventRetentionIndexes } from "./retention";

testFor("database")(
  "retention index waits for old snapshots without blocking ordinary pool queries",
  async () => {
    await requireInfra("database");
    const database = await createDisposableDatabase("retention_startup");
    const monitor = new SQL(database.url, { max: 1 });
    const pool = new SQL(database.url, { max: 2 });
    let blocker: ReservedSQL | undefined;
    let build: Promise<boolean> | undefined;
    let probes: Promise<unknown> | undefined;
    try {
      blocker = await monitor.reserve();
      await pool`CREATE SCHEMA workflows`;
      await pool`CREATE TABLE workflows.event (id uuid PRIMARY KEY, dispatched_at timestamptz, dispatch_failed_at timestamptz, payload_expired_at timestamptz)`;
      await pool`CREATE TABLE workflows.run (event_id uuid)`;
      // This snapshot must outlive the expression index's validation phase.
      await blocker`BEGIN ISOLATION LEVEL REPEATABLE READ`;
      await blocker`SELECT * FROM workflows.event`;
      build = ensureWorkflowEventRetentionIndexes(pool);

      // Monitor through a separate connection; the pool under test may be blocked.
      const observer = new SQL(database.url, { max: 1 });
      try {
        const deadline = performance.now() + 5_000;
        let waiting = false;
        while (performance.now() < deadline) {
          const [progress] = await observer<{ phase: string }[]>`
            SELECT phase FROM pg_stat_progress_create_index WHERE datname = current_database()
          `;
          if (progress?.phase === "waiting for old snapshots") {
            waiting = true;
            break;
          }
          await Bun.sleep(25);
        }
        expect(waiting).toBe(true);
        // More queries than pool connections exercise Bun's concurrent-query
        // queue. None may land behind the snapshot-blocked index statement.
        probes = Promise.all(Array.from({ length: 4 }, () => pool`SELECT 1`.execute()));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            probes,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("Ordinary query queued behind retention index")), 5_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      } finally {
        await observer.close();
      }
    } finally {
      // Release the snapshot before draining queries, also on a regression.
      if (blocker) {
        await blocker`ROLLBACK`;
        blocker.release();
      }
      try {
        if (build) expect(await build).toBe(true);
        await probes;
      } finally {
        await pool.close();
        await monitor.close();
        await database.drop();
      }
    }
  },
  30_000,
);
