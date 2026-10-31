import { test as bunTest, expect } from "bun:test";
import { formatAppKey } from "@k2b/cloud/app-key";
import { RUNNER_PATHS } from "@k2b/cloud/code/runner";
import { APP_KEY_FIXTURES, INSTALLATION_ID, KEY_ID } from "../../../scripts/fixtures/app-key-fixtures";
import { config, lease, source } from "./fixtures";

// UID changes require the production capability envelope. CI runs this entire file in
// the runner image; the ordinary unprivileged unit suite must not weaken isolation.
const test = bunTest.skipIf(process.getuid?.() !== 0);

test("SIGTERM stops acquisition while an accepted sandbox finishes and reports completion", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const completed: unknown[] = [];
  let fetches = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === RUNNER_PATHS.config) return Response.json(config);
      if (path === RUNNER_PATHS.fetch) {
        fetches++;
        if (fetches === 1) return Response.json({ runs: [lease()] });
        // Abort the long-poll on shutdown; never emit a late accepted run.
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return Response.json({ runs: [] });
      }
      if (path === RUNNER_PATHS.bundle) return new Response(source);
      if (path === RUNNER_PATHS.heartbeat) return Response.json({ leaseExpiresAt: lease().leaseExpiresAt });
      if (path === RUNNER_PATHS.call) {
        entered.resolve();
        await finish.promise;
        return Response.json({ ok: true, data: null });
      }
      if (path === RUNNER_PATHS.complete) {
        completed.push(await request.json());
        return Response.json({});
      }
      return new Response(null, { status: 404 });
    },
  });
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      `${import.meta.dir}/fixed-clock.ts`,
      import.meta.path.endsWith(".ts") ? `${import.meta.dir}/../src/index.ts` : `${import.meta.dir}/runner.js`,
    ],
    {
      env: {
        CLOUD_APP_KEY: formatAppKey({ installationId: INSTALLATION_ID, keyId: KEY_ID, appId: "runner", seed: APP_KEY_FIXTURES[0].seed }),
        CLOUD_CORE_INTERNAL_ORIGIN: server.url.origin,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered.promise,
      child.exited.then(async () => {
        throw new Error(await new Response(child.stderr).text());
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("sandbox_not_started")), 5000);
      }),
    ]);
    clearTimeout(timer);
    child.kill("SIGTERM");
    // The pending bridge call proves the accepted run remains alive after the signal.
    await Bun.sleep(50);
    expect(child.exitCode).toBeNull();
    const atStop = fetches;
    finish.resolve();
    expect(await child.exited).toBe(0);
    expect(fetches).toBe(atStop);
    expect(completed).toEqual([{ runId: "run-a", generation: 1, token: "opaque-run-token", outcome: "succeeded" }]);
  } finally {
    clearTimeout(timer);
    finish.resolve();
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await server.stop(true);
  }
}, 10_000);
