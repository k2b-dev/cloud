import { expect, test } from "bun:test";
import { WorkerdEngine } from "../src/engine";
import { config, lease, source } from "./fixtures";

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
      async () => {
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
      try { await cloud.call('denied', null); } catch (error) { await cloud.call('report', error.message); }
    }`,
      config,
      async (operation, input) => {
        if (operation === "denied") throw new RunnerCallError("code_access_removed");
        reported.push(input);
        return null;
      },
      signal,
    );
    expect(await engine.run(run, signal)).toBe("succeeded");
    expect(reported).toEqual(["code_access_removed"]);
  } finally {
    await engine.close();
  }
}, 10_000);
