import { test as bunTest, expect } from "bun:test";
import type { RunnerJsonValue } from "@k2b/cloud/code/runner";
import { type SandboxCall, WorkerdEngine } from "../src/engine";
import { config, lease } from "./fixtures";

// Executed by runner-attacks in the real image, never with weaker local isolation.
const test = bunTest.skipIf(process.getuid?.() !== 0);

async function attack(source: string, call: SandboxCall, input: RunnerJsonValue = null) {
  const engine = new WorkerdEngine();
  const run = lease({ input });
  const signal = AbortSignal.timeout(5000);
  try {
    await engine.load(run, source, config, call, signal);
    return await engine.run(run, signal);
  } finally {
    await engine.close();
  }
}

test("hostile fetch, DNS and connect cannot reach even a live supervisor listener", async () => {
  let hits = 0;
  const canary = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      hits++;
      return new Response("reachable");
    },
  });
  const results: RunnerJsonValue[] = [];
  try {
    const targets = [canary.url.origin, "http://169.254.169.254/latest/meta-data/", "https://example.com/", "http://app-core:3000/"];
    expect(
      await attack(
        `export async function main(targets, cloud) {
          const results = [];
          for (const target of targets) {
            try { await fetch(target); results.push('ESCAPE'); }
            catch (error) { results.push(error.message.includes('not permitted to access the internet') ? 'denied' : error.message); }
          }
          const {connect} = await import('cloudflare:sockets');
          try { const socket = connect({hostname: '127.0.0.1', port: ${canary.port}}); await socket.opened; results.push('ESCAPE'); }
          catch (error) { results.push(error.message.includes('not permitted to access the internet') ? 'denied' : error.message); }
          await cloud.call('report', results);
        }`,
        async (_, input) => {
          results.push(input);
          return null;
        },
        targets,
      ),
    ).toBe("succeeded");
    expect(results).toEqual([["denied", "denied", "denied", "denied", "denied"]]);
    expect(hits).toBe(0);
  } finally {
    await canary.stop(true);
  }
}, 10_000);

test("filesystem, environment, child processes and loader authority are absent from Code", async () => {
  const results: RunnerJsonValue[] = [];
  expect(
    await attack(
      `export async function main(input, cloud) {
        const modules = ['fs', 'node:fs', 'child_process', 'node:child_process', 'net', 'dns'];
        const available = modules.filter(name => { try { return !!process.getBuiltinModule(name); } catch { return false; } });
        await cloud.call('report', {available, env: Object.keys(process.env),
          bun: typeof Bun, require: typeof require, fetcher: typeof cloud.fetch,
          loader: typeof cloud.LOADER, token: typeof cloud.token, key: typeof cloud.key});
      }`,
      async (_, input) => {
        results.push(input);
        return null;
      },
    ),
  ).toBe("succeeded");
  expect(results).toEqual([
    {
      available: [],
      env: [],
      bun: "undefined",
      require: "undefined",
      fetcher: "undefined",
      loader: "undefined",
      token: "undefined",
      key: "undefined",
    },
  ]);
}, 10_000);

test("giant call input is refused before the supervisor callback and giant results stay bounded", async () => {
  let admitted = 0;
  const inputErrors: RunnerJsonValue[] = [];
  expect(
    await attack(
      `export async function main(input, cloud) {
        try { await cloud.call('oversized', 'x'.repeat(${config.bridgeBytes * 2})); throw new Error('ESCAPE'); }
        catch (error) { await cloud.call('report', error.message); }
      }`,
      async (operation, input) => {
        if (operation === "oversized") admitted++;
        else inputErrors.push(input);
        return null;
      },
    ),
  ).toBe("succeeded");
  expect(admitted).toBe(0);
  expect(inputErrors).toEqual(["runner_bridge_unavailable"]);
  const outputErrors: RunnerJsonValue[] = [];
  expect(
    await attack(
      `export async function main(input, cloud) {
        try { await cloud.call('oversized', null); throw new Error('ESCAPE'); }
        catch (error) { await cloud.call('report', error.message); }
        // The entrypoint discards return values and workerd stderr goes to /dev/null.
        console.log('x'.repeat(128 * 1024));
        return 'x'.repeat(128 * 1024);
      }`,
      async (operation, input) => {
        if (operation === "oversized") return "x".repeat(config.bridgeBytes * 2);
        outputErrors.push(input);
        return null;
      },
    ),
  ).toBe("succeeded");
  expect(outputErrors).toEqual(["runner_bridge_unavailable"]);
}, 10_000);

test("call flood receives the exact concurrency refusal without an unbounded queue", async () => {
  const engine = new WorkerdEngine();
  const run = lease();
  const held = Promise.withResolvers<null>();
  let heldCalls = 0;
  let running: Promise<unknown> | undefined;
  const signal = AbortSignal.timeout(5000);
  try {
    await engine.load(
      run,
      `export async function main(input, cloud) {
        const first = cloud.call('hold', null);
        // RPC submissions preserve order; leave the first one pending.
        const errors = await Promise.all(Array.from({length: 32}, async () => {
          try { await cloud.call('hold', null); return 'ESCAPE'; } catch (error) { return error.message; }
        }));
        if (errors.some(error => error !== 'runner_bridge_busy')) throw new Error('unexpected flood result');
        void first.catch(() => {});
      }`,
      config,
      async () => {
        heldCalls++;
        return held.promise;
      },
      signal,
    );
    running = engine.run(run, signal);
    expect(await running).toBe("succeeded");
    expect(heldCalls).toBe(1);
  } finally {
    held.resolve(null);
    await engine.close();
    await running;
  }
}, 10_000);
