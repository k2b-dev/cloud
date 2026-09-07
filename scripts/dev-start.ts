#!/usr/bin/env bun
/**
 * dev:start <app...> — start one or more apps in the running dev stack.
 *
 * Joins the existing default network created by `bun run dev`, so each
 * started app reaches `ipa_postgres` / `ipa_valkey` / `ipa_nats_1..3` / `gateway` without
 * extra config. The gateway picks it up from the Redis registry within ~5s.
 *
 * No --build here — use `dev:restart` to reload mounted source and
 * `dev:rebuild` when you need a fresh image. This keeps `dev:start` snappy
 * for the common "I just stopped it, start it again" loop.
 */
import { color, composeUpAndWait, helpFor, resolveApps } from "./dev-cli";

const inputs = process.argv.slice(2);

if (inputs.length === 0) {
  helpFor("bun run dev:start <app...>", [
    "Start one or more apps in the running stack.",
    "",
    "Examples:",
    "  bun run dev:start notebooks",
    "  bun run dev:start notebooks files grids",
  ]);
  process.exit(0);
}

const services = await resolveApps(inputs);

await composeUpAndWait([], services);

for (const s of services) {
  console.log(`${color.green}✓${color.reset} ${s} is ready`);
}
