#!/usr/bin/env bun
/**
 * Run a command under a machine's heavy-run slot.
 *
 *   bun scripts/heavy.ts <command> [args...]
 */
import { runInHeavySlot } from "./heavy-lock";

const help = `Usage: bun scripts/heavy.ts <command> [args...]

Runs the command under a free heavy-run slot shared with bun run check and
bun run test on this machine. CLOUD_HEAVY_SLOTS (default 1) sets the number
of slots; waits when all are busy. The command sees CLOUD_HEAVY_LOCK=held,
so nested bun run check or bun run test do not wait again.
In CI, without flock, or when already held, runs the command directly.
Exits with the command's exit code.

Examples:
  bun scripts/heavy.ts docker build -f packages/mail/Dockerfile .
  bun scripts/heavy.ts bun test packages/ui/test/browser/foo.browser.test.ts
`;

const args = Bun.argv.slice(2);
if (args[0] === "--help" || args[0] === "-h") {
  console.log(help);
  process.exit(0);
}
if (!args.length) {
  console.error(help);
  process.exit(2);
}
process.exit(runInHeavySlot(args));
