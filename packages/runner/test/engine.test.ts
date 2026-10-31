import { expect, test } from "bun:test";
import { WorkerdEngine } from "../src/engine";
import { config, lease, source } from "./fixtures";

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
    let network = 'blocked'; try { await fetch('http://127.0.0.1:1'); network = 'open'; } catch {}
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
  try {
    const run = lease();
    const code = `export async function main(input, cloud) {
      const kept = []; for (;;) { kept.push(new Uint8Array(8 * 1024 * 1024).fill(1)); await cloud.call('yield', null); }
    }`;
    const signal = new AbortController().signal;
    await engine.load(run, code, { ...config, processMemoryBytes: 96 * 1024 * 1024 }, async () => null, signal);
    expect(await engine.run(run, signal)).toBe("memory_limit");
  } finally {
    await engine.close();
  }
}, 10_000);
