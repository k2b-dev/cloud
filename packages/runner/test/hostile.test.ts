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
          // workerd ships node:net and node:dns modules; using them must still fail.
          const net = process.getBuiltinModule('node:net');
          const dns = process.getBuiltinModule('node:dns');
          const attempts = [
            () => new Promise((resolve, reject) => {
              const socket = net.connect(${canary.port}, '127.0.0.1');
              socket.once('connect', () => { socket.write('GET / HTTP/1.1\\r\\nHost: canary\\r\\n\\r\\n'); resolve(); });
              socket.once('error', reject);
            }),
            () => dns.promises.lookup('example.com'),
            () => dns.promises.resolve4('example.com'),
          ];
          results.push(...await Promise.all(attempts.map(async attempt => {
            try {
              await Promise.race([attempt(), new Promise((_, reject) => setTimeout(() => reject(new Error('no answer')), 1000))]);
              return 'ESCAPE';
            } catch { return 'denied'; }
          })));
          await cloud.call('report', results);
        }`,
        async (_, input) => {
          results.push(input);
          return null;
        },
        targets,
      ),
    ).toBe("succeeded");
    expect(results).toEqual([Array.from({ length: 8 }, () => "denied")]);
    expect(hits).toBe(0);
  } finally {
    await canary.stop(true);
  }
}, 10_000);

test("filesystem, environment, child processes and loader authority are unusable from Code", async () => {
  const results: RunnerJsonValue[] = [];
  expect(
    await attack(
      `export async function main(key, cloud) {
        const modules = ['fs', 'node:fs'];
        const available = modules.filter(name => { try { return !!process.getBuiltinModule(name); } catch { return false; } });
        // workerd ships a node:child_process module whose calls must never start a process.
        const child = process.getBuiltinModule('node:child_process');
        // node:fs/promises is workerd's virtual filesystem; host paths must stay unreachable.
        const files = process.getBuiltinModule('node:fs/promises');
        const attempts = [
          () => files.readFile(key),
          () => files.readFile('/run/runner-key/source'),
          () => files.readdir('/run/runner-key'),
          () => files.readFile('/proc/self/environ'),
          () => files.readFile('/proc/1/environ'),
          () => files.readFile('/tmp/../app/runner.js'),
          () => files.readFile('/etc/passwd'),
          () => files.writeFile('/app/escape', 'x'),
          () => child.execSync('id'),
          () => child.execFileSync('/bin/sh', ['-c', 'id']),
          () => { const result = child.spawnSync('/bin/sh', ['-c', 'id']); if (result.error) throw result.error; },
          () => new Promise((resolve, reject) => {
            const spawned = child.spawn('/bin/sh', ['-c', 'id']);
            spawned.once('spawn', resolve);
            spawned.once('error', reject);
          }),
          () => cloud.fetch('http://127.0.0.1:1'),
          () => cloud.token(), () => cloud.key(), () => cloud.LOADER.load({}),
        ];
        // Concurrent attempts keep a silent hang within one second.
        const authority = await Promise.all(attempts.map(async attempt => {
          try {
            await Promise.race([attempt(), new Promise((_, reject) => setTimeout(() => reject(new Error('no answer')), 1000))]);
            return 'ESCAPE';
          } catch { return 'denied'; }
        }));
        await cloud.call('report', {available, env: Object.keys(process.env),
          bun: typeof Bun, require: typeof require, authority});
      }`,
      async (_, input) => {
        results.push(input);
        return null;
      },
      // The entrypoint-staged 0400 copy in runner-attacks.
      process.env.CLOUD_APP_KEY_FILE ?? "/run/runner-key/source",
    ),
  ).toBe("succeeded");
  expect(results).toEqual([
    {
      available: [],
      env: [],
      bun: "undefined",
      require: "undefined",
      authority: Array.from({ length: 16 }, () => "denied"),
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
