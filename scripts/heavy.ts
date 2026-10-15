#!/usr/bin/env bun
/**
 * Run a command under a machine's heavy-run slot.
 *
 *   bun --no-env-file scripts/heavy.ts <command> [args...]
 */
import { dotenvLeak } from "./fixtures/test-infra-env";
import { runInHeavySlot } from "./heavy-lock";

const help = `Usage: bun --no-env-file scripts/heavy.ts <command> [args...]

Runs the command under a free heavy-run slot shared with bun run check and
bun run test on this machine. CLOUD_HEAVY_SLOTS (default 1) sets the number
of slots; waits when all are busy. The command sees CLOUD_HEAVY_LOCK=held,
so nested bun run check or bun run test do not wait again.
In CI, without flock, or when already held, runs the command directly.
Exits with the command's exit code.

Examples:
  bun --no-env-file scripts/heavy.ts docker build -f packages/mail/Dockerfile .
  bun --no-env-file scripts/heavy.ts bun test <file>.browser.test.ts
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
const leak = dotenvLeak(process.cwd(), process.execArgv);
if (leak) {
  console.error(
    `heavy.ts started without --no-env-file next to ${leak}; run it as \`bun --no-env-file scripts/heavy.ts <command>\` so the command never sees development values.`,
  );
  process.exit(2);
}
process.exit(runInHeavySlot(args));
