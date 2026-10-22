#!/usr/bin/env bun
import { help, parseArgs } from "./perf-baseline/model";

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2));
    if (options.help) console.log(help);
    else if (options.rank && options.bottlenecks) {
      const { rankFromFiles } = await import("./perf-baseline/rank");
      console.log(await rankFromFiles(options.rank, options.bottlenecks));
    } else {
      const { runUnderHeavyLock } = await import("../../../scripts/heavy-lock");
      runUnderHeavyLock();
      const { run } = await import("./perf-baseline/runner");
      await run(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
