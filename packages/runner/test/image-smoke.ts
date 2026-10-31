/** CI-only container smoke: compiled runner, native workerd, read-only root and no network outside loopback. */

import { unlink } from "node:fs/promises";
import type { RunnerConfig } from "@k2b/cloud/code/runner";

if (Bun.argv.includes("--help")) {
  console.log(
    "Usage: bun /smoke.ts\nRun inside the runner image; exercises its compiled runner and native workerd against a local mock Core.",
  );
  process.exit(0);
}
const NOW = Date.UTC(2030, 0, 2);
const config: RunnerConfig = {
  slots: 1,
  pollMs: 100,
  retryMs: 5,
  transportMs: 3000,
  bundleBytes: 64 * 1024,
  cacheBytes: 128 * 1024,
  bridgeBytes: 64 * 1024,
  bridgeConcurrency: 1,
  processMemoryBytes: 128 * 1024 * 1024,
};
const source = 'export async function main(input, cloud) { await cloud.call("smoke", input); }';
const keyFile = "/tmp/runner-smoke.key";
const clockFile = "/tmp/runner-smoke-clock.js";
// RFC 8032 public test-vector seed, never an installation credential.
await Bun.write(
  keyFile,
  "cloud-app-key-v1.11111111-1111-4111-8111-111111111111.runner.22222222-2222-4222-8222-222222222222.nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
  { mode: 0o400 },
);
await Bun.write(clockFile, `Date.now = () => ${NOW};`);
const done = Promise.withResolvers<void>();
let claimed = false;
let called = false;
const core = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch: async (request) => {
    switch (new URL(request.url).pathname.split("/").at(-1)) {
      case "config":
        return Response.json(config);
      case "fetch": {
        if (claimed) {
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return Response.json({ runs: [] });
        }
        claimed = true;
        return Response.json({
          runs: [
            {
              runId: "smoke-run",
              codeId: "smoke-code",
              versionId: "smoke-version",
              organizationId: "smoke-org",
              trustTier: "approved",
              entrypoint: "main",
              generation: 1,
              mandateRevision: 1,
              bundleHash: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
              token: "public-smoke-token",
              input: null,
              deadlineAt: NOW + 5000,
              leaseExpiresAt: NOW + 5000,
              heartbeatMs: 100,
            },
          ],
        });
      }
      case "bundle":
        return new Response(source);
      case "call":
        called = true;
        return Response.json({ ok: true, data: null });
      case "heartbeat":
        return Response.json({ leaseExpiresAt: NOW + 5000 });
      case "complete": {
        const result: unknown = await request.json();
        if (!called || typeof result !== "object" || result === null || !("outcome" in result) || result.outcome !== "succeeded")
          done.reject(new Error("runner_image_attempt_failed"));
        else done.resolve();
        return Response.json({});
      }
      default:
        return new Response(null, { status: 404 });
    }
  },
});
const runner = Bun.spawn([process.execPath, "--no-env-file", "--preload", clockFile, "/app/runner.js"], {
  env: { CLOUD_APP_KEY_FILE: keyFile, CLOUD_CORE_INTERNAL_ORIGIN: core.url.origin },
  stdin: "ignore",
  stdout: "ignore",
  stderr: "inherit",
});
let timeout: ReturnType<typeof setTimeout> | undefined;
try {
  await Promise.race([
    done.promise,
    runner.exited.then(() => {
      throw new Error("runner_image_exited_early");
    }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("runner_image_smoke_timeout")), 10_000);
    }),
  ]);
  runner.kill("SIGTERM");
  if ((await runner.exited) !== 0) throw new Error("runner_image_drain_failed");
  console.log("Runner image: compiled startup, sandbox bridge and SIGTERM passed");
} finally {
  clearTimeout(timeout);
  if (runner.exitCode === null) runner.kill("SIGKILL");
  await runner.exited;
  await core.stop(true);
  await Promise.all([keyFile, clockFile].map((file) => unlink(file)));
}
