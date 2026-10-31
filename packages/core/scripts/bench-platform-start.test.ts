import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

for (const [entry, appId] of [
  ["identity-search.ts", "core"],
  ["provider-process.ts", "bench-provider"],
] as const) {
  test(`${entry} initializes its selected transport before domain work`, async () => {
    const root = resolve(import.meta.dir, "../../..");
    const directory = await mkdtemp(resolve(tmpdir(), "cloud-bench-start-"));
    const preload = resolve(directory, "observe.ts");
    await Bun.write(
      preload,
      `
      import { spyOn } from "bun:test";
      import * as startup from ${JSON.stringify(resolve(root, "packages/cloud/src/start.ts"))};
      import { connections } from ${JSON.stringify(resolve(root, "packages/cloud/src/runtime/connections.ts"))};
      const initialize = startup.initializePlatform;
      spyOn(startup, "initializePlatform").mockImplementation(async (options) => {
        await initialize(options);
        const snapshot = connections();
        const target = new URL(snapshot.database.url);
        process.send({ appId: snapshot.appId, port: target.port, database: target.pathname });
        // Stop before SQL or other domain work; this test needs no services.
        throw new Error("benchmark-startup-observed");
      });
    `,
    );
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("CLOUD_TEST_")) delete env[key];
    const observations: unknown[] = [];
    const child = Bun.spawn([process.execPath, `bench/${entry}`], {
      cwd: resolve(root, "packages/core"),
      env: {
        ...env,
        BUN_OPTIONS: `--no-env-file --preload=${preload}`,
        DATABASE_URL: "postgres://test:test@127.0.0.1:9/cloud_identity_bench_startup",
        POSTGRES_URL: undefined,
        PGURL: undefined,
        REDIS_URL: "redis://127.0.0.1:9",
        VALKEY_URL: undefined,
        CLOUD_APP_KEY: undefined,
        CLOUD_APP_KEY_FILE: undefined,
        IDENTITY_BENCH_SAMPLES: "20",
        IDENTITY_BENCH_MODE: "measure",
      },
      stdout: "pipe",
      stderr: "pipe",
      ipc: (message) => observations.push(message),
    });
    const timeout = setTimeout(() => child.kill(), 4_000);
    try {
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("benchmark-startup-observed");
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({ appId, database: "/cloud_identity_bench_startup" });
      if (appId === "core") expect(observations[0]).not.toMatchObject({ port: "9" });
      else expect(observations[0]).toMatchObject({ port: "9" });
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
      await child.exited;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
