#!/usr/bin/env bun
/**
 * dev:rebuild <app...> | --all — rebuild image(s) and restart the apps.
 *
 * `compose up --build` is the one-shot version: builds the new image,
 * recreates the container, brings it up. Compose builds the services
 * in parallel by default so multiple apps spin up at once.
 *
 * Use this after a UI, dependency, package-manifest, or Dockerfile change.
 * Bind-mounted application and platform source only needs `dev:restart`.
 * `--all` first makes sure the infrastructure stack is up.
 */
import { color, composeUpAndWait, ensureInfra, helpFor, listDevServices, resolveApps } from "./dev-cli";

const inputs = process.argv.slice(2);

if (inputs.length === 0) {
  helpFor("bun run dev:rebuild <app...> | --all", [
    "Rebuild image(s) and restart one or more apps, or every app with --all.",
    "Use it after UI, dependency, package-manifest, or Dockerfile changes.",
    "Use dev:restart for bind-mounted application or platform source.",
    "",
    "Examples:",
    "  bun run dev:rebuild notebooks",
    "  bun run dev:rebuild notebooks files grids",
    "  bun run dev:rebuild --all",
  ]);
  process.exit(0);
}

if (inputs.includes("--all") && inputs.length > 1) {
  console.error('Error: "--all" cannot be combined with app names.');
  process.exit(1);
}

const rebuildAll = inputs[0] === "--all";
if (rebuildAll) await ensureInfra();
const services = rebuildAll ? await listDevServices() : await resolveApps(inputs);

await composeUpAndWait(["--build"], services);

for (const s of services) {
  console.log(`${color.green}✓${color.reset} ${s} rebuilt and ready`);
}
