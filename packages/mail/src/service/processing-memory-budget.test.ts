import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as services from "@k2b/cloud/services";

import {
  MAIL_PROCESSING_MEMORY_BUDGET_BYTES as budget,
  estimateExtractionWorkingSet,
  estimateHydrationWorkingSet,
  processingMemoryState,
  resetProcessingMemoryHighWater,
  withProcessingMemory,
} from "./processing-memory-budget";

const info = mock(() => {});
const logger = spyOn(services, "logger").mockReturnValue({ info, warn: () => {}, error: () => {}, debug: () => {} });
const clock = spyOn(performance, "now").mockReturnValue(0);
afterAll(() => {
  logger.mockRestore();
  clock.mockRestore();
});

const held = (weightBytes: number, label = "test", signal?: AbortSignal) => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const done = withProcessingMemory({ weightBytes, label, signal }, async () => {
    started.resolve();
    await release.promise;
  });
  return { started: started.promise, release: release.resolve, done };
};

afterEach(() => {
  expect(processingMemoryState()).toMatchObject({ inFlightBytes: 0, inFlightCount: 0, waiting: 0 });
  resetProcessingMemoryHighWater();
  info.mockClear();
  clock.mockReturnValue(0);
});

describe("processing memory budget", () => {
  test("uses measured working-set factors, rounded up", () => {
    expect(estimateHydrationWorkingSet({ sourceBytes: 30, htmlBytes: 4 })).toBe(340);
    expect(estimateHydrationWorkingSet({ sourceBytes: 0.1, htmlBytes: 0 })).toBe(1);
    expect(estimateExtractionWorkingSet(18)).toBe(360);
    expect(estimateExtractionWorkingSet(0.01)).toBe(1);
  });

  test("admits concurrent items only up to the byte budget", async () => {
    const a = held(budget / 2);
    const b = held(budget / 2);
    const c = held(1);
    await Promise.all([a.started, b.started]);
    expect(processingMemoryState()).toMatchObject({ inFlightBytes: budget, inFlightCount: 2, waiting: 1 });
    a.release();
    await a.done;
    await c.started;
    expect(processingMemoryState().inFlightBytes).toBe(budget / 2 + 1);
    b.release();
    c.release();
    await Promise.all([b.done, c.done]);
    expect(processingMemoryState().highWaterBytes).toBe(budget);
  });

  test("FIFO: small items do not overtake a waiting large item", async () => {
    const a = held(budget / 2);
    const b = held(budget);
    const c = held(1);
    const d = held(budget);
    await a.started;
    expect(processingMemoryState()).toMatchObject({ inFlightCount: 1, waiting: 3 });
    a.release();
    await a.done;
    await b.started;
    expect(processingMemoryState()).toMatchObject({ inFlightBytes: budget, waiting: 2 });
    b.release();
    await b.done;
    await c.started;
    expect(processingMemoryState()).toMatchObject({ inFlightBytes: 1, waiting: 1 });
    c.release();
    await c.done;
    await d.started;
    d.release();
    await d.done;
  });

  test("oversized work waits, runs alone and blocks later items", async () => {
    const a = held(1);
    const b = held(budget + 1);
    const c = held(1);
    await a.started;
    expect(processingMemoryState()).toMatchObject({ inFlightBytes: 1, waiting: 2 });
    a.release();
    await a.done;
    await b.started;
    expect(processingMemoryState()).toMatchObject({ inFlightBytes: budget + 1, inFlightCount: 1, waiting: 1 });
    b.release();
    await b.done;
    await c.started;
    c.release();
    await c.done;
    expect(processingMemoryState()).toMatchObject({ highWaterBytes: budget + 1, largestAloneBytes: budget + 1 });
  });

  test("releases exactly once on a thrown error and wakes the next item", async () => {
    const failure = new Error("work failed");
    const release = Promise.withResolvers<void>();
    const failed = withProcessingMemory({ weightBytes: budget, label: "throw" }, async () => {
      await release.promise;
      throw failure;
    });
    const rejection = failed.catch((error: unknown) => error);
    const next = held(1);
    release.resolve();
    expect(await rejection).toBe(failure);
    await next.started;
    expect(processingMemoryState()).toMatchObject({ inFlightBytes: 1, inFlightCount: 1, waiting: 0 });
    next.release();
    await next.done;
  });

  for (const reasonKind of ["explicit", "default", "absent"] as const) {
    test(`aborting a waiter (${reasonKind} reason) removes it and wakes the next`, async () => {
      const a = held(1);
      const controller = new AbortController();
      if (reasonKind === "absent") Object.defineProperty(controller.signal, "reason", { value: undefined });
      const failure = new Error("stopped");
      const b = held(budget, "aborted", controller.signal);
      const rejected = b.done.catch((error: unknown) => error);
      const c = held(1);
      controller.abort(reasonKind === "explicit" ? failure : undefined);
      const reason = await rejected;
      if (reasonKind === "absent") expect(reason).toMatchObject({ code: "PROCESSING_CANCELLED" });
      else expect(reason).toBe(controller.signal.reason);
      await c.started;
      expect(processingMemoryState()).toMatchObject({ inFlightBytes: 2, inFlightCount: 2, waiting: 0 });
      a.release();
      c.release();
      await Promise.all([a.done, c.done]);
    });
  }

  test("an already aborted signal never enters the queue", async () => {
    const reason = new Error("already stopped");
    await expect(
      withProcessingMemory({ weightBytes: 1, label: "aborted", signal: AbortSignal.abort(reason) }, async () => {
        throw new Error("must not run");
      }),
    ).rejects.toBe(reason);
  });

  test("abort after admission releases the reservation without starting work", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped before work");
    let ran = false;
    const done = withProcessingMemory({ weightBytes: budget, label: "admitted", signal: controller.signal }, async () => {
      ran = true;
    });
    controller.abort(reason);
    await expect(done).rejects.toBe(reason);
    expect(ran).toBe(false);
  });

  test("a synchronous throw also releases its reservation", async () => {
    const error = new Error("synchronous failure");
    await expect(
      withProcessingMemory({ weightBytes: budget, label: "synchronous throw" }, () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  test("invalid weights fail clearly; fractional positive weights round up", async () => {
    for (const weightBytes of [0, -1, NaN, Infinity]) {
      await expect(withProcessingMemory({ weightBytes, label: "invalid" }, async () => undefined)).rejects.toBeInstanceOf(RangeError);
    }
    await withProcessingMemory({ weightBytes: 0.1, label: "fractional" }, async () => {
      expect(processingMemoryState().inFlightBytes).toBe(1);
    });
  });

  test("logs each long wait or oversized reservation once without content", async () => {
    const a = held(budget);
    await a.started;
    const b = held(1, "queued item");
    clock.mockReturnValue(1001);
    a.release();
    await a.done;
    await b.started;
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenLastCalledWith("Mail processing memory reservation", { label: "queued item", weightBytes: 1, waitedMs: 1001 });
    b.release();
    await b.done;
    await withProcessingMemory({ weightBytes: budget + 1, label: "oversized item" }, async () => undefined);
    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenLastCalledWith("Mail processing memory reservation", {
      label: "oversized item",
      weightBytes: budget + 1,
      waitedMs: 0,
    });
  });

  test("high-water reset retains current reservations", async () => {
    await withProcessingMemory({ weightBytes: budget + 1, label: "large" }, async () => undefined);
    const a = held(2);
    await a.started;
    resetProcessingMemoryHighWater();
    expect(processingMemoryState()).toMatchObject({ highWaterBytes: 2, largestAloneBytes: 2 });
    a.release();
    await a.done;
    resetProcessingMemoryHighWater();
    expect(processingMemoryState()).toMatchObject({ highWaterBytes: 0, largestAloneBytes: 0 });
  });
});
