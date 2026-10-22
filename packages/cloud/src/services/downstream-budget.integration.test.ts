// biome-ignore assist/source/organizeImports: Resolve test targets before runtime imports.
import { requireInfraUrl, suiteFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { expect, test } from "bun:test";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { RedisClient } from "bun";
import { createDownstreamBudget, DownstreamBusyError } from "./downstream-budget";

suiteFor("valkey")("shared downstream admission across processes", () => {
  for (const [downstream, capacity] of [
    ["gotenberg", 2],
    ["smtp", 8],
  ] as const)
    test(`${downstream} keeps one fleet capacity and recovers released slots`, async () => {
      const namespace = testSyncNamespace(`downstream-${downstream}`);
      type Probe = {
        child: Bun.Subprocess<"pipe", "pipe", "pipe">;
        output: Promise<void>;
        errors: Promise<ArrayBuffer>;
        wait(event: string): Promise<void>;
      };
      const children: Probe[] = [];
      const spawn = (): Probe => {
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            "--no-env-file",
            "--preload",
            new URL("../../../../scripts/fixtures/test-infra.ts", import.meta.url).pathname,
            new URL("./downstream-budget.test-fixture.ts", import.meta.url).pathname,
            downstream,
            namespace,
          ],
          env: { ...process.env, REDIS_URL: requireInfraUrl("valkey"), SYNC_NAMESPACE: namespace },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        const lines: string[] = [];
        const output = (async () => {
          for await (const line of createInterface({ input: Readable.from(child.stdout) })) lines.push(line);
        })();
        const errors = new Response(child.stderr).arrayBuffer();
        const probe = {
          child,
          output,
          errors,
          wait: async (event: string) => {
            const deadline = Date.now() + 10_000;
            while (!lines.includes(event)) {
              if (child.exitCode !== null) {
                await output;
                if (lines.includes(event)) return;
                throw new Error(`Budget child did not reach ${event}: ${lines.join(", ")}`);
              }
              if (Date.now() >= deadline) throw new Error(`Budget child timed out before ${event}`);
              await Bun.sleep(5);
            }
          },
        };
        children.push(probe);
        return probe;
      };
      const client = new RedisClient(requireInfraUrl("valkey"));
      try {
        const holders = Array.from({ length: capacity }, spawn);
        await Promise.all(holders.map((holder) => holder.wait("admitted")));
        // Test preloads assign process-local namespaces; replicas must still use the shared test key.
        expect(Number(await client.send("ZCARD", [`cloud:downstream:{${namespace}}:${downstream}`]))).toBe(capacity);
        const busy = spawn();
        await busy.wait("DownstreamBusyError");
        expect(await busy.child.exited).toBe(1);
        holders[0]!.child.stdin.write("release\n");
        holders[0]!.child.stdin.flush();
        await holders[0]!.wait("released");
        await holders[0]!.child.exited;
        await spawn().wait("admitted");
      } finally {
        for (const probe of children) if (probe.child.exitCode === null) probe.child.kill("SIGKILL");
        await Promise.all(
          children.map(async (probe) => {
            await probe.child.exited;
            await Promise.all([probe.output, probe.errors]);
          }),
        );
        try {
          await client.send("DEL", [`cloud:downstream:{${namespace}}:${downstream}`]);
        } finally {
          client.close();
        }
      }
    }, 35_000);
  test("a short operation cannot expire the slots of longer operations", async () => {
    const client = new RedisClient(requireInfraUrl("valkey"));
    await client.connect();
    const namespace = testSyncNamespace("downstream-mixed");
    const budget = createDownstreamBudget({ client: async () => client, namespace: () => namespace });
    const releases: Array<() => void> = [];
    try {
      releases.push(await budget.acquire({ downstream: "gotenberg", timeoutMs: 5000, signal: AbortSignal.timeout(5000) }));
      releases.push(await budget.acquire({ downstream: "gotenberg", timeoutMs: 25, signal: AbortSignal.timeout(1000) }));
      // The short token expires, but it must not shorten the key's TTL and
      // erase the long operation's token with it.
      await Bun.sleep(100);
      releases.push(await budget.acquire({ downstream: "gotenberg", timeoutMs: 5000, signal: AbortSignal.timeout(5000) }));
      await expect(budget.acquire({ downstream: "gotenberg", timeoutMs: 5000, signal: AbortSignal.timeout(5000) })).rejects.toBeInstanceOf(
        DownstreamBusyError,
      );
    } finally {
      for (const release of releases) release();
      await client.send("DEL", [`cloud:downstream:{${namespace}}:gotenberg`]);
      client.close();
    }
  });
});
