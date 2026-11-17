// Include C17 acceptance in the existing production-container engine gate.
import "./test-kit.engine.test";
import "./jobs.engine.test";
import "./chat-job.engine.test";
import { test as bunTest, expect } from "bun:test";
import { CODE_OUTPUT_OPERATION } from "@k2b/cloud/code";
import { WorkerdEngine } from "../src/engine";
import { config, lease, source } from "./fixtures";

// UID changes require the production capability envelope. CI runs this entire file in
// the runner image; the ordinary unprivileged unit suite must not weaken isolation.
const test = bunTest.skipIf(process.getuid?.() !== 0);

test("killing an attempt during process startup never executes its bundle", async () => {
  const engine = new WorkerdEngine();
  const calls: string[] = [];
  const signal = new AbortController().signal;
  const run = lease();
  try {
    await engine.load(
      run,
      source,
      config,
      async (operation) => {
        calls.push(operation);
        return null;
      },
      signal,
    );
    const pending = engine.run(run, signal);
    await engine.kill(run.runId);
    expect(await pending).toBe("failed");
    expect(calls).toEqual([]);
    const next = lease({ runId: "after-startup-cancellation" });
    await engine.load(next, source, config, async () => null, signal);
    expect(await engine.run(next, signal)).toBe("succeeded");
  } finally {
    await engine.close();
  }
});

// Deadlines belong to Runner; engine fixtures use fixed instants and no random output expectations.
test("pinned workerd loads a fresh worker and exposes only cloud.call", async () => {
  const engine = new WorkerdEngine();
  const calls: unknown[] = [];
  try {
    const run = lease();
    await engine.load(
      run,
      source,
      config,
      async (operation, input) => {
        calls.push({ operation, input });
        return null;
      },
      new AbortController().signal,
    );
    expect(await engine.run(run, new AbortController().signal)).toBe("succeeded");
    expect(calls).toEqual([{ operation: "echo", input: { hello: "world" } }]);
  } finally {
    await engine.close();
  }
}, 10_000);

test("global fetch and connect are unavailable; dynamic workers share no globals or environment", async () => {
  const engine = new WorkerdEngine();
  const results: unknown[] = [];
  const code = `let count = 0; export async function main(input, cloud) {
    let network = 'blocked'; try { await fetch('http://127.0.0.1:1'); network = 'open'; } catch (error) { if (!error.message.includes('not permitted to access the internet')) network = 'wrong_error'; }
    let filesystem = false; try { filesystem = !!process.getBuiltinModule('fs'); } catch {}
    await cloud.call('probe', { count: ++count, network, env: Object.keys(process.env), filesystem, connect: typeof connect, keys: Object.keys(cloud) });
  }`;
  try {
    for (const runId of ["one", "two"]) {
      const run = lease({ runId });
      await engine.load(
        run,
        code,
        config,
        async (_, input) => {
          results.push(input);
          return null;
        },
        new AbortController().signal,
      );
      expect(await engine.run(run, new AbortController().signal)).toBe("succeeded");
    }
    expect(results).toEqual(
      Array.from({ length: 2 }, () => ({ count: 1, network: "blocked", env: [], filesystem: false, connect: "undefined", keys: [] })),
    );
  } finally {
    await engine.close();
  }
}, 10_000);

test("stall watchdog kills a looping process while another organization keeps executing", async () => {
  const engine = new WorkerdEngine();
  try {
    const looping = lease({ runId: "loop" });
    const neighbor = lease({ runId: "neighbor", organizationId: "org-b" });
    const noop = async () => null;
    const signal = new AbortController().signal;
    await engine.load(looping, "export function main() { while (true) {} }", config, noop, signal);
    await engine.load(neighbor, source, config, noop, signal);
    const hung = engine.run(looping, signal);
    expect(await engine.run(neighbor, signal)).toBe("succeeded");
    expect(await hung).toBe("stalled");
  } finally {
    await engine.close();
  }
}, 10_000);

test("the process memory budget terminates allocation without killing another group", async () => {
  const engine = new WorkerdEngine();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<null>();
  try {
    const run = lease();
    const code = `export async function main(input, cloud) {
      const kept = []; for (;;) { kept.push(new Uint8Array(8 * 1024 * 1024).fill(1)); await cloud.call('yield', null); }
    }`;
    const signal = new AbortController().signal;
    const neighbor = lease({ runId: "memory-neighbor", organizationId: "other-org" });
    await engine.load(
      neighbor,
      source,
      config,
      async () => {
        entered.resolve();
        return finish.promise;
      },
      signal,
    );
    const running = engine.run(neighbor, signal);
    await entered.promise;
    await engine.load(run, code, { ...config, processMemoryBytes: 96 * 1024 * 1024 }, async () => null, signal);
    expect(await engine.run(run, signal)).toBe("memory_limit");
    finish.resolve(null);
    expect(await running).toBe("succeeded");
  } finally {
    finish.resolve(null);
    await engine.close();
  }
}, 10_000);

test("parallel sandbox calls above the budget fail without building an HTTP work queue", async () => {
  const engine = new WorkerdEngine();
  const held = Promise.withResolvers<null>();
  let calls = 0;
  try {
    const run = lease();
    const signal = new AbortController().signal;
    await engine.load(
      run,
      `export async function main(input, cloud) {
      await Promise.all([cloud.call('first', null), cloud.call('second', null)]);
    }`,
      config,
      async (operation) => {
        // The new console lane is independent of the deliberately held capability.
        if (operation === CODE_OUTPUT_OPERATION) return null;
        calls++;
        return held.promise;
      },
      signal,
    );
    expect(await engine.run(run, signal)).toBe("failed");
    expect(calls).toBe(1);
  } finally {
    held.resolve(null);
    await engine.close();
  }
}, 10_000);

test("cancelling one attempt preserves another attempt in the same organization and trust tier", async () => {
  const engine = new WorkerdEngine();
  const firstEntered = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const firstFinish = Promise.withResolvers<null>();
  const secondFinish = Promise.withResolvers<null>();
  const first = lease({ runId: "cancelled" });
  const second = lease({ runId: "continuing" });
  const controller = new AbortController();
  try {
    await engine.load(
      first,
      source,
      config,
      async () => {
        firstEntered.resolve();
        return firstFinish.promise;
      },
      controller.signal,
    );
    await engine.load(
      second,
      source,
      config,
      async () => {
        secondEntered.resolve();
        return secondFinish.promise;
      },
      new AbortController().signal,
    );
    const a = engine.run(first, controller.signal);
    await firstEntered.promise;
    const b = engine.run(second, new AbortController().signal);
    await secondEntered.promise;
    controller.abort();
    expect(await a).toBe("failed");
    await engine.kill(first.runId);
    secondFinish.resolve(null);
    expect(await b).toBe("succeeded");
  } finally {
    firstFinish.resolve(null);
    secondFinish.resolve(null);
    await engine.close();
  }
}, 10_000);

test("a retiring process never consumes a new attempt without executing it", async () => {
  const engine = new WorkerdEngine();
  const calls: string[] = [];
  try {
    const signal = new AbortController().signal;
    const first = lease({ runId: "first" });
    const next = lease({ runId: "next" });
    await engine.load(
      first,
      source,
      config,
      async () => {
        calls.push("first");
        return null;
      },
      signal,
    );
    expect(await engine.run(first, signal)).toBe("succeeded");
    const retiring = engine.kill(first.runId);
    await engine.load(
      next,
      source,
      config,
      async () => {
        calls.push("next");
        return null;
      },
      signal,
    );
    expect(await engine.run(next, signal)).toBe("succeeded");
    await retiring;
    expect(calls).toEqual(["first", "next"]);
  } finally {
    await engine.close();
  }
}, 10_000);

test("bridge calls remain open past Bun's default ten-second idle timeout", async () => {
  const engine = new WorkerdEngine();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = lease();
    const signal = new AbortController().signal;
    await engine.load(
      run,
      source,
      config,
      async () => {
        // fixed wait: cross Bun's native ten-second idle boundary to catch premature connection closure.
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 11_000);
        });
        return null;
      },
      signal,
    );
    expect(await engine.run(run, signal)).toBe("succeeded");
  } finally {
    clearTimeout(timer);
    await engine.close();
  }
}, 15_000);

test("stable Core refusal codes survive the sandbox bridge without exception details", async () => {
  const { RunnerCallError } = await import("@k2b/cloud/code/runner");
  const engine = new WorkerdEngine();
  const reported: unknown[] = [];
  const signal = new AbortController().signal;
  try {
    const run = lease();
    await engine.load(
      run,
      `export async function main(input, cloud) {
      try { await cloud.call('denied', null); } catch (error) { await cloud.call('report', { code: error.code, status: error.status }); }
    }`,
      config,
      async (operation, input) => {
        if (operation === "denied") throw new RunnerCallError("code_access_removed", undefined, 403);
        reported.push(input);
        return null;
      },
      signal,
    );
    expect(await engine.run(run, signal)).toBe("succeeded");
    expect(reported).toEqual([{ code: "code_access_removed", status: 403 }]);
  } finally {
    await engine.close();
  }
}, 10_000);

test("shared workerd keeps console output and uncaught stacks bound to their own run, with no text in the terminal report", async () => {
  const { CODE_OUTPUT_OPERATION, CodeOutputBatchSchema } = await import("@k2b/cloud/code");
  const engine = new WorkerdEngine();
  const signal = new AbortController().signal;
  const left = lease({ runId: "console-left" });
  const right = lease({ runId: "console-right" });
  const received = new Map<string, string[]>();
  try {
    for (const run of [left, right]) {
      await engine.load(
        run,
        `console.log('top level ${run.runId}'); export async function main() { console.error('line ${run.runId}'); ${run === right ? "throw new Error('sandbox stack right');" : "return null;"} }`,
        config,
        async (operation, input) => {
          expect(operation).toBe(CODE_OUTPUT_OPERATION);
          const batch = CodeOutputBatchSchema.parse(input);
          received.set(run.runId, [...(received.get(run.runId) ?? []), ...batch.lines.map((line) => line.text)]);
          return null;
        },
        signal,
      );
    }
    expect(await Promise.all([engine.run(left, signal), engine.run(right, signal)])).toEqual(["succeeded", "failed"]);
    expect(received.get(left.runId)).toEqual(["top level console-left", "line console-left"]);
    expect(received.get(right.runId)?.some((line) => line.includes("Error: sandbox stack right"))).toBe(true);
    expect(received.get(right.runId)?.some((line) => line.includes("bundle.js"))).toBe(true);
    expect(received.get(left.runId)?.join("\n")).not.toContain("right");
    expect(received.get(right.runId)?.join("\n")).not.toContain("left");
  } finally {
    await engine.close();
  }
}, 10_000);

test("harden supervisor output pacing for direct calls in the native isolate", async () => {
  const { setSystemTime } = await import("bun:test");
  const { CODE_OUTPUT_INTERVAL_MS } = await import("@k2b/cloud/code");
  const { Runner } = await import("../src/runner");
  const { bundleHash } = await import("../src/cache");
  const now = Date.UTC(2030, 0, 2);
  setSystemTime(now);
  const source = `export async function main(input, cloud) {
    for (let seq=1; seq<=100; seq++) await cloud.call('runtime.output', { seq, lines: [{level:'log',text:'fixture'}], droppedLines:0, droppedBytes:0 });
    await cloud.call('done', null);
  }`;
  const run = lease({ runId: "paced-native", bundleHash: bundleHash(source), deadlineAt: now + 5000, leaseExpiresAt: now + 5000 });
  let fetched = false;
  const sent: { at: number; dropped: number }[] = [];
  const engine = new WorkerdEngine();
  const runner = new Runner(
    {
      configure: async () => ({ ...config, slots: 1 }),
      fetch: async (_, signal) => {
        if (!fetched) {
          fetched = true;
          return { runs: [run] };
        }
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { runs: [] };
      },
      bundle: async () => source,
      heartbeat: async () => ({ leaseExpiresAt: now + 5000 }),
      output: async ({ batch }) => {
        sent.push({ at: Date.now(), dropped: batch.droppedLines });
      },
      call: async () => {
        setSystemTime(now + CODE_OUTPUT_INTERVAL_MS);
        return { ok: true, data: null };
      },
      complete: async ({ outcome }) => {
        expect(outcome).toBe("succeeded");
        runner.stop();
      },
    },
    engine,
  );
  try {
    await runner.start();
    expect(sent).toEqual([
      { at: now, dropped: 0 },
      { at: now + CODE_OUTPUT_INTERVAL_MS, dropped: 99 },
    ]);
  } finally {
    runner.stop();
    await engine.close();
    setSystemTime();
  }
}, 10000);
