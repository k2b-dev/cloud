#!/usr/bin/env bun
/**
 * dev:rebuild <app...> — rebuild image(s) and restart the apps.
 *
 * `compose up --build` is the one-shot version: builds the new image,
 * recreates the container, brings it up. Compose builds the services
 * in parallel by default so multiple apps spin up at once.
 *
 * Use this after a UI, dependency, package-manifest, or Dockerfile change.
 * Bind-mounted application and platform source only needs `dev:restart`.
 */
import { color, composeUpAndWait, helpFor, resolveApps } from "./dev-cli";

const inputs = process.argv.slice(2);

if (inputs.length === 0) {
  helpFor("bun run dev:rebuild <app...>", [
    "Rebuild image(s) and restart one or more apps.",
    "Use it after UI, dependency, package-manifest, or Dockerfile changes.",
    "Use dev:restart for bind-mounted application or platform source.",
    "",
    "Examples:",
    "  bun run dev:rebuild notebooks",
    "  bun run dev:rebuild notebooks files grids",
    "",
    "For a full stack rebuild: bun run dev:rebuild:all",
  ]);
  process.exit(0);
}

const services = await resolveApps(inputs);

await composeUpAndWait(["--build"], services);

for (const s of services) {
  console.log(`${color.green}✓${color.reset} ${s} rebuilt and ready`);
}
