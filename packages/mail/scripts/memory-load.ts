#!/usr/bin/env bun
import { help, parseArgs } from "./memory-load/model";

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2));
    if (options.help) console.log(help);
    else {
      // Bun's default Redis handle binds at process startup, before test-infra can map the URL.
      // Re-enter once with the test URL already present, preserving --no-env-file and all CLI options.
      const testValkey = process.env.CLOUD_TEST_VALKEY_URL?.trim();
      if (testValkey && process.env.REDIS_URL !== testValkey) {
        const { applyTestRuntimeEnv } = await import("../../../scripts/fixtures/test-infra-env");
        const env = { ...process.env };
        applyTestRuntimeEnv(env);
        const child = Bun.spawn([process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
          env,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        const forward = (signal: NodeJS.Signals) => child.kill(signal);
        process.on("SIGINT", forward);
        process.on("SIGTERM", forward);
        try {
          process.exitCode = await child.exited;
        } finally {
          process.off("SIGINT", forward);
          process.off("SIGTERM", forward);
        }
      } else {
        const { runUnderHeavyLock } = await import("../../../scripts/heavy-lock");
        runUnderHeavyLock();
        const { run } = await import("./memory-load/runner");
        await run(options);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
