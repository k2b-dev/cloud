#!/usr/bin/env bun
/**
 * dev:stop <app...> — stop one or more apps in the dev stack.
 *
 * Container stays around (use `dev:start` to bring it back without
 * rebuilding). For a full removal, use `bun run dev:down` which tears
 * the whole stack down.
 */
import { color, compose, helpFor, resolveApps } from "./dev-cli";

const inputs = process.argv.slice(2);

if (inputs.length === 0) {
  helpFor("bun run dev:stop <app...>", [
    "Stop one or more apps. Containers stay around for fast restart.",
    "",
    "Examples:",
    "  bun run dev:stop notebooks",
    "  bun run dev:stop notebooks filesv2",
  ]);
  process.exit(0);
}

const services = await resolveApps(inputs);

await compose(["stop", ...services]);

for (const s of services) {
  console.log(`${color.yellow}■${color.reset} ${s} stopped`);
}
