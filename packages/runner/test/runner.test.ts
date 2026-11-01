import { expect, jest, test } from "bun:test";
import type { RunnerBridge, RunnerCompleteRequest, RunnerLease, RunnerLeaseProof } from "@k2b/cloud/code/runner";
import { BundleCache, bundleHash } from "../src/cache";
import type { RunnerEngine } from "../src/engine";
import { reserveJobIdentities } from "../src/identities";
import { Runner } from "../src/runner";
import { config, lease, source } from "./fixtures";

const NOW = Date.UTC(2030, 0, 2);
const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("Expected runner state was not reached");
};
function mockBridge(runs: RunnerLease[]) {
  const completions: RunnerCompleteRequest[] = [];
  const fetched: number[] = [];
  const beats: RunnerLeaseProof[] = [];
  let bundles = 0;
  const bridge: RunnerBridge = {
    configure: async () => config,
    fetch: async ({ freeSlots }, signal) => {
      fetched.push(freeSlots);
      if (runs.length) return { runs: runs.splice(0, freeSlots) };
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { runs: [] };
    },
    bundle: async () => {
      bundles++;
      return source;
    },
    heartbeat: async (request) => {
      beats.push(request);
      return { leaseExpiresAt: NOW + 5000 };
    },
    complete: async (request) => {
      completions.push(request);
    },
    call: async () => ({ ok: true, data: null }),
  };
  return { bridge, completions, fetched, beats, bundles: () => bundles };
}

test("free slots bound admission, heartbeat carries the lease, stop drains without fetching", async () => {
  jest.setSystemTime(NOW);
  const mock = mockBridge([lease({ runId: "a", heartbeatMs: 5 }), lease({ runId: "b" }), lease({ runId: "c" })]);
  const finish = Promise.withResolvers<void>();
  const started: string[] = [];
  const engine: RunnerEngine = {
    load: async () => {},
    run: async (run) => {
      started.push(run.runId);
      await finish.promise;
      return "succeeded";
    },
    kill: async () => {},
    close: async () => {},
  };
  const runner = new Runner(mock.bridge, engine);
  const running = runner.start();
  try {
    await waitFor(() => started.length === 2 && mock.beats.length > 0);
    expect(mock.fetched).toEqual([2]);
    expect(mock.bundles()).toBe(2);
    expect(mock.beats[0]).toEqual({ runId: "a", generation: 1, token: "opaque-run-token" });
    runner.stop();
    expect(mock.completions).toHaveLength(0);
    finish.resolve();
    await running;
    expect(mock.fetched).toEqual([2]);
    expect(mock.completions.map(({ outcome }) => outcome)).toEqual(["succeeded", "succeeded"]);
    expect(started).toEqual(["a", "b"]);
  } finally {
    runner.stop();
    finish.resolve();
    await running;
    jest.useRealTimers();
  }
});

test("stop cancels an outstanding long-poll and ignores leases racing its cancellation", async () => {
  jest.setSystemTime(NOW);
  const mock = mockBridge([]);
  let polling = false;
  mock.bridge.fetch = async (_, signal) => {
    polling = true;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { runs: [lease()] };
  };
  let loaded = false;
  const engine: RunnerEngine = {
    load: async () => {
      loaded = true;
    },
    run: async () => "succeeded",
    kill: async () => {},
    close: async () => {},
  };
  const runner = new Runner(mock.bridge, engine);
  const running = runner.start();
  try {
    await waitFor(() => polling);
    runner.stop();
    await running;
    expect(loaded).toBe(false);
  } finally {
    runner.stop();
    await running;
    jest.useRealTimers();
  }
});

for (const cause of ["wall_clock_limit", "lease_lost"] as const) {
  test(`an uncompleted run stops at ${cause} without resetting its budget`, async () => {
    jest.setSystemTime(NOW);
    const mock = mockBridge([lease({ deadlineAt: NOW + (cause === "wall_clock_limit" ? 20 : 5000), leaseExpiresAt: NOW + 30 })]);
    const engine: RunnerEngine = {
      load: async () => {},
      run: async (_, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("aborted");
      },
      kill: async () => {},
      close: async () => {},
    };
    const runner = new Runner(mock.bridge, engine);
    const running = runner.start();
    try {
      await waitFor(() => mock.completions.length > 0);
      runner.stop();
      await running;
      expect(mock.completions[0]?.outcome).toBe(cause);
    } finally {
      runner.stop();
      await running;
      jest.useRealTimers();
    }
  });
}

test("bundle cache rejects hash mismatch, bounds memory and evicts least recently used modules", async () => {
  const cache = new BundleCache(2, 2);
  let reads = 0;
  const read = async (text: string) => {
    reads++;
    return text;
  };
  for (const text of ["a", "b", "a", "c", "b"]) await cache.get(bundleHash(text), () => read(text));
  expect(reads).toBe(4);
  await expect(cache.get(bundleHash("x"), () => read("z"))).rejects.toThrow("runner_invalid_bundle");
  await expect(cache.get(bundleHash("long"), () => read("long"))).rejects.toThrow("runner_invalid_bundle");
});

test("a fenced heartbeat immediately ends its attempt before the previous lease expires", async () => {
  const { RunnerLeaseLostError } = await import("@k2b/cloud/code/runner");
  jest.setSystemTime(NOW);
  const mock = mockBridge([lease({ heartbeatMs: 5 })]);
  mock.bridge.heartbeat = async () => {
    throw new RunnerLeaseLostError();
  };
  const engine: RunnerEngine = {
    load: async () => {},
    run: async (_, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return "failed";
    },
    kill: async () => {},
    close: async () => {},
  };
  const runner = new Runner(mock.bridge, engine);
  const running = runner.start();
  try {
    await waitFor(() => mock.completions.length > 0);
    runner.stop();
    await running;
    expect(mock.completions[0]?.outcome).toBe("lease_lost");
  } finally {
    runner.stop();
    await running;
    jest.useRealTimers();
  }
});

test("a fenced bundle download reports lease_lost without executing code", async () => {
  const { RunnerLeaseLostError } = await import("@k2b/cloud/code/runner");
  jest.setSystemTime(NOW);
  const mock = mockBridge([lease()]);
  mock.bridge.bundle = async () => {
    throw new RunnerLeaseLostError();
  };
  let executed = false;
  const runner = new Runner(mock.bridge, {
    load: async () => {
      executed = true;
    },
    run: async () => "succeeded",
    kill: async () => {},
    close: async () => {},
  });
  const running = runner.start();
  try {
    await waitFor(() => mock.completions.length > 0);
    runner.stop();
    await running;
    expect(mock.completions[0]?.outcome).toBe("lease_lost");
    expect(executed).toBe(false);
  } finally {
    runner.stop();
    await running;
    jest.useRealTimers();
  }
});

test("identical bundles retain independent lease failures across organizations", async () => {
  const { RunnerLeaseLostError } = await import("@k2b/cloud/code/runner");
  jest.setSystemTime(NOW);
  const mock = mockBridge([lease({ runId: "a" }), lease({ runId: "b", organizationId: "other-org" })]);
  mock.bridge.bundle = async ({ runId }) => {
    if (runId === "a") throw new RunnerLeaseLostError();
    return source;
  };
  const runner = new Runner(mock.bridge, {
    load: async () => {},
    run: async () => "succeeded",
    kill: async () => {},
    close: async () => {},
  });
  const running = runner.start();
  try {
    await waitFor(() => mock.completions.length === 2);
    runner.stop();
    await running;
    expect(mock.completions.find(({ runId }) => runId === "a")?.outcome).toBe("lease_lost");
    expect(mock.completions.find(({ runId }) => runId === "b")?.outcome).toBe("succeeded");
  } finally {
    runner.stop();
    await running;
    jest.useRealTimers();
  }
});

test("C13b jobs and runs consume one shared advertised slot budget", async () => {
  jest.setSystemTime(NOW);
  const mock = mockBridge([]);
  let polls = 0;
  const started: string[] = [];
  const finish = Promise.withResolvers<void>();
  const bridge: RunnerBridge = {
    ...mock.bridge,
    fetch: async ({ freeSlots }, signal) => {
      polls++;
      expect(freeSlots).toBe(2);
      if (polls === 1)
        return {
          runs: [lease()],
          jobs: [
            {
              kind: "check",
              jobId: "11111111-1111-4111-8111-111111111111",
              generation: 1,
              leaseKey: "a".repeat(64),
              deadlineAt: NOW + 5000,
              leaseExpiresAt: NOW + 5000,
              heartbeatMs: 100,
              inputBytes: 2,
              outputBytes: 1000,
            },
          ],
        };
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { runs: [] };
    },
    jobInput: async () => "{}",
    jobHeartbeat: async () => ({ leaseExpiresAt: NOW + 5000 }),
    jobComplete: async () => {},
  };
  const engine: RunnerEngine = {
    load: async () => {},
    run: async () => {
      started.push("run");
      await finish.promise;
      return "succeeded";
    },
    kill: async () => {},
    close: async () => {},
  };
  const runner = new Runner(
    bridge,
    engine,
    () => {},
    async () => {
      started.push("check");
      await finish.promise;
      return { kind: "check", result: { ok: false, diagnostics: [] } };
    },
  );
  const running = runner.start();
  try {
    await waitFor(() => started.length === 2);
    expect(polls).toBe(1);
    runner.stop();
    finish.resolve();
    await running;
    expect(started.sort()).toEqual(["check", "run"]);
  } finally {
    runner.stop();
    finish.resolve();
    await running;
    jest.useRealTimers();
  }
});

test("C13b successfully reaped job ranges are reused without consuming production identities", () => {
  const first = reserveJobIdentities();
  const expected = first.first;
  first.release();
  for (let index = 0; index < 40000; index++) {
    const next = reserveJobIdentities();
    expect(next.first).toBe(expected);
    next.release();
  }
});
