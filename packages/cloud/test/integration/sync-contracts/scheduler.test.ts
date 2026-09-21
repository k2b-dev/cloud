import { afterAll, beforeAll, expect, test } from "bun:test";
import { natsSuite } from "../../../../../scripts/fixtures/test-infra";
import { openSync } from "./harness";

const suite = natsSuite();

/**
 * Cron schedules have a one-minute floor, so the contract is exercised with
 * manual runs: accepted runs are broker-durable, execute once a process-side
 * worker exists, and a paused schedule holds them until it is resumed.
 */
suite("scheduler contract", () => {
  let fixture: Awaited<ReturnType<typeof openSync>>;
  const runs: string[] = [];

  beforeAll(async () => {
    fixture = await openSync("scheduler");
  });
  afterAll(async () => {
    await fixture?.close();
  });

  test("runs accepted without a worker execute once the worker starts, and pause defers them until resume", async () => {
    const scheduler = fixture.sync.scheduler({ id: "contract", delivery: { maxAttempts: 1, ackWaitMs: 5_000 } });
    await scheduler.create({
      id: "tick",
      cron: "* * * * *",
      misfire: "latest",
      process: async (context) => {
        runs.push(context.runId);
      },
    });
    const offline = await scheduler.runNow({ id: "tick", requestId: "offline" });
    expect(runs).toEqual([]);

    const worker = await scheduler.process();
    try {
      expect(await scheduler.awaitRun({ id: "tick", runId: offline.runId, timeoutMs: 5_000 })).toEqual({ completed: true });
      expect(runs).toEqual([offline.runId]);

      await scheduler.pause({ id: "tick" });
      const paused = await scheduler.runNow({ id: "tick", requestId: "paused" });
      expect(await scheduler.awaitRun({ id: "tick", runId: paused.runId, timeoutMs: 1_000 })).toEqual({ completed: false });
      expect(runs).toEqual([offline.runId]);

      await scheduler.resume({ id: "tick" });
      expect(await scheduler.awaitRun({ id: "tick", runId: paused.runId, timeoutMs: 5_000 })).toEqual({ completed: true });
      expect(runs).toEqual([offline.runId, paused.runId]);
      expect((await scheduler.get({ id: "tick" }))?.runNumber).toBe(2);
    } finally {
      worker.stop();
      await worker.drain();
    }
  }, 20_000);
});
