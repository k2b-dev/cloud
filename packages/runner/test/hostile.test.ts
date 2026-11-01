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
        const attempts = [
          () => cloud.fetch('http://127.0.0.1:1'),
          () => cloud.token(), () => cloud.key(), () => cloud.LOADER.load({}),
        ];
        const authority = [];
        for (const attempt of attempts) {
          try { await attempt(); authority.push('ESCAPE'); }
          catch { authority.push('denied'); }
        }
        await cloud.call('report', {available, env: Object.keys(process.env),
          bun: typeof Bun, require: typeof require, authority});
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
      authority: ["denied", "denied", "denied", "denied"],
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
        // runner-attacks fails if this canary appears anywhere in the job log.
        const canary = ['C14', 'OUTPUT', 'CANARY'].join('_');
        console.log(canary.repeat(16 * 1024));
        console.error(canary.repeat(16 * 1024));
        return canary.repeat(16 * 1024);
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
        await new Promise((resolve, reject) => {
          let refused = 0;
          for (let i = 0; i < 33; i++) {
            // Any one request may win the slot. It remains held until test cleanup.
            void cloud.call('hold', null).then(
              () => reject(new Error('unexpected admission')),
              error => {
                if (error.message !== 'runner_bridge_busy') reject(error);
                else if (++refused === 32) resolve();
              }
            );
          }
        });
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
