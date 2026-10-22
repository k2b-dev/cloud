import { describe, expect, mock, spyOn, test } from "bun:test";
import type { Lock, Mutex } from "@k2b/sync";
import { runExclusive } from "./setup-lock";

const deferred = <T>() => Promise.withResolvers<T>();

const fixture = () => {
  let time = 0;
  let tick: (() => Promise<void> | undefined) | undefined;
  const lease: Lock = { resource: "faq", ownerToken: "test", fence: 1n, expiresAt: new Date(60_000) };
  const mutex = {
    ready: mock(async () => {}),
    acquire: mock(async (_input: { resource: string }): Promise<Lock | null> => lease),
    extend: mock(async () => {
      lease.expiresAt = new Date(time + 60_000);
      return true;
    }),
    release: mock(async () => true),
  } satisfies Pick<Mutex, "ready" | "acquire" | "extend" | "release">;
  const loggedAt: number[] = [];
  const log = {
    info: mock((_message: string, _metadata?: Record<string, unknown>) => {
      loggedAt.push(time);
    }),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
  const cancelled = deferred<void>();
  const cancel = mock(() => {
    cancelled.resolve();
  });
  const sleeps: number[] = [];
  const options = {
    mutex,
    resource: "faq",
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
    schedule: (renew: () => Promise<void> | undefined, intervalMs: number) => {
      expect(intervalMs).toBe(20_000);
      tick = renew;
      return cancel;
    },
    log,
  };
  return {
    options,
    mutex,
    lease,
    log,
    loggedAt,
    sleeps,
    cancel,
    cancelled: cancelled.promise,
    time: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    tick: () => {
      if (!tick) throw new Error("Setup has not started");
      return tick();
    },
  };
};

describe("application setup lease", () => {
  test("waits beyond the NATS startup budget with bounded backoff and logs at most every 30 seconds", async () => {
    const f = fixture();
    const random = spyOn(Math, "random").mockReturnValue(0.5);
    f.mutex.acquire.mockImplementation(async ({ resource }) => {
      expect(resource).toBe("faq");
      expect(f.mutex.ready).toHaveBeenCalledTimes(1);
      if (f.time() < 365_000) return null;
      f.lease.expiresAt = new Date(f.time() + 60_000);
      return f.lease;
    });
    const run = mock(async () => {});
    try {
      await runExclusive({ ...f.options, run });
      expect(f.sleeps.slice(0, 4)).toEqual([250, 500, 1_000, 2_000]);
      expect(Math.max(...f.sleeps)).toBeLessThanOrEqual(2_000);
      const calls = f.log.info.mock.calls;
      const loggedAt = f.loggedAt;
      expect(calls.length).toBe(13);
      expect(calls[0]).toEqual(["waiting for setup on another replica", { appId: "faq", waitedMs: 0 }]);
      for (let i = 1; i < loggedAt.length; i++) expect(loggedAt[i]! - loggedAt[i - 1]!).toBeGreaterThanOrEqual(30_000);
      expect(run).toHaveBeenCalledTimes(1);
      expect(f.mutex.release).toHaveBeenCalledWith(f.lease);
      expect(f.cancel).toHaveBeenCalledTimes(1);
    } finally {
      random.mockRestore();
    }
  });

  test("releases on success and preserves a setup error even if release fails", async () => {
    const f = fixture();
    await runExclusive({ ...f.options, run: async () => {} });
    expect(f.mutex.release).toHaveBeenCalledWith(f.lease);
    const error = new Error("migration failed");
    f.mutex.release.mockRejectedValueOnce(new Error("NATS disconnected"));
    await expect(
      runExclusive({
        ...f.options,
        run: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(f.mutex.release).toHaveBeenCalledTimes(2);
    expect(f.cancel).toHaveBeenCalledTimes(2);
    expect(f.log.warn).toHaveBeenCalledTimes(1);
  });

  test("a false release is visible without failing successful setup", async () => {
    const f = fixture();
    f.mutex.release.mockResolvedValue(false);
    await runExclusive({ ...f.options, run: async () => {} });
    expect(f.log.warn).toHaveBeenCalledTimes(1);
  });

  for (const fails of [false, true]) {
    test(`lost lease releases and ${fails ? "preserves the setup error" : "rejects after setup returns"}`, async () => {
      const f = fixture();
      const error = new Error("setup failed too");
      const entered = deferred<void>();
      const finish = deferred<void>();
      f.mutex.extend.mockResolvedValue(false);
      const result = runExclusive({
        ...f.options,
        run: async () => {
          entered.resolve();
          await finish.promise;
          if (fails) throw error;
        },
      });
      // Attach a handler before releasing the setup barrier.
      const outcome = result.then(
        () => undefined,
        (error: unknown) => error,
      );
      await entered.promise;
      await f.tick();
      expect(f.mutex.release).not.toHaveBeenCalled();
      finish.resolve();
      const failure = await outcome;
      if (fails) expect(failure).toBe(error);
      else expect(failure).toBeInstanceOf(Error);
      if (!fails) expect(String(failure)).toContain("Setup lease lost");
      expect(f.mutex.release).toHaveBeenCalledWith(f.lease);
      expect(f.log.error).toHaveBeenCalledTimes(1);
    });
  }

  test("a thrown renewal followed by a confirmed extension keeps the lease", async () => {
    const f = fixture();
    f.mutex.extend.mockRejectedValueOnce(new Error("timeout"));
    await runExclusive({
      ...f.options,
      run: async () => {
        f.advance(20_000);
        await f.tick();
        f.advance(20_000);
        await f.tick();
        expect(f.lease.expiresAt.getTime()).toBe(100_000);
        f.advance(25_000); // Past the original expiry, but inside the renewed lease.
      },
    });
    expect(f.log.warn).toHaveBeenCalledTimes(1);
    expect(f.log.error).not.toHaveBeenCalled();
  });

  test("renewal errors until expiry lose the lease even between timer ticks", async () => {
    const f = fixture();
    f.mutex.extend.mockRejectedValue(new Error("disconnected"));
    await expect(
      runExclusive({
        ...f.options,
        run: async () => {
          for (let i = 0; i < 2; i++) {
            f.advance(20_000);
            await f.tick();
          }
          f.advance(20_001);
        },
      }),
    ).rejects.toThrow("Setup lease lost");
    expect(f.mutex.release).toHaveBeenCalledWith(f.lease);
    expect(f.log.error).toHaveBeenCalledTimes(1);
  });

  test("expiry while renewal is in flight stays lost even if the response later succeeds", async () => {
    const f = fixture();
    const extended = deferred<boolean>();
    f.mutex.extend.mockImplementation(() => extended.promise);
    await expect(
      runExclusive({
        ...f.options,
        run: async () => {
          f.advance(20_000);
          const extending = f.tick();
          f.advance(40_000);
          await f.tick();
          // A late response cannot undo a gap in confirmed ownership during setup.
          f.lease.expiresAt = new Date(120_000);
          extended.resolve(true);
          await extending;
        },
      }),
    ).rejects.toThrow("Setup lease lost");
    expect(f.mutex.extend).toHaveBeenCalledTimes(1);
    expect(f.mutex.release).toHaveBeenCalledWith(f.lease);
  });

  test("a late success after renewal errors cannot hide expiry between timer ticks", async () => {
    const f = fixture();
    f.mutex.extend.mockRejectedValueOnce(new Error("timeout"));
    await expect(
      runExclusive({
        ...f.options,
        run: async () => {
          f.advance(20_000);
          await f.tick();
          const extended = deferred<boolean>();
          f.mutex.extend.mockImplementationOnce(async () => {
            await extended.promise;
            f.lease.expiresAt = new Date(f.time() + 60_000);
            return true;
          });
          f.advance(20_000);
          const extending = f.tick();
          f.advance(20_001);
          extended.resolve(true);
          await extending;
        },
      }),
    ).rejects.toThrow("Setup lease lost");
    expect(f.mutex.release).toHaveBeenCalledWith(f.lease);
  });

  test("expiry after setup finished does not turn a delayed renewal error into setup loss", async () => {
    const f = fixture();
    const extended = deferred<boolean>();
    const entered = deferred<void>();
    const finish = deferred<void>();
    f.mutex.extend.mockImplementation(() => extended.promise);
    const result = runExclusive({
      ...f.options,
      run: async () => {
        entered.resolve();
        await finish.promise;
      },
    });
    await entered.promise;
    f.advance(20_000);
    const extending = f.tick();
    finish.resolve();
    await f.cancelled;
    f.advance(40_001);
    extended.reject(new Error("delayed timeout"));
    await extending;
    await result;
    expect(f.log.warn).toHaveBeenCalledTimes(1);
    expect(f.log.error).not.toHaveBeenCalled();
    expect(f.mutex.release).toHaveBeenCalledWith(f.lease);
  });

  test("never overlaps renewals and waits for the in-flight extend before release", async () => {
    const f = fixture();
    const extended = deferred<boolean>();
    const entered = deferred<void>();
    const finish = deferred<void>();
    f.mutex.extend.mockImplementation(() => extended.promise);
    const result = runExclusive({
      ...f.options,
      run: async () => {
        entered.resolve();
        await finish.promise;
      },
    });
    await entered.promise;
    f.advance(20_000);
    const extending = f.tick();
    f.advance(20_000);
    await f.tick();
    expect(f.mutex.extend).toHaveBeenCalledTimes(1);
    finish.resolve();
    // The in-flight renewal holds cleanup; cancellation signals that setup has returned.
    await f.cancelled;
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.mutex.release).not.toHaveBeenCalled();
    extended.resolve(true);
    await extending;
    await result;
    expect(f.mutex.release).toHaveBeenCalledTimes(1);
  });
});
