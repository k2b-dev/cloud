#!/usr/bin/env bun
/**
 * dev:restart <app...> — reload bind-mounted source without rebuilding images.
 *
 * Recreate rather than `docker compose restart` so current Compose commands and
 * mounts are applied. The existing image is required and each requested service
 * must pass its readiness check before this command succeeds.
 */
import { color, composeUpAndWait, helpFor, listRunningDevServices, resolveApps } from "./dev-cli";

const inputs = process.argv.slice(2);

if (inputs.length === 0) {
  helpFor("bun run dev:restart <app...> | --running", [
    "Reload mounted source without rebuilding images.",
    "Use --running after a shared packages/cloud or styles.css change.",
    "Use dev:rebuild for UI, dependency, manifest, or Dockerfile changes.",
    "",
    "Examples:",
    "  bun run dev:restart grids",
    "  bun run dev:restart gateway gateway-ops",
    "  bun run dev:restart --running",
  ]);
  process.exit(0);
}

if (inputs.includes("--running") && inputs.length > 1) {
  console.error('Error: "--running" cannot be combined with app names.');
  process.exit(1);
}

const restartRunning = inputs[0] === "--running";
const services = restartRunning ? await listRunningDevServices() : await resolveApps(inputs);

if (services.length === 0) {
  console.log("No running Cloud services to restart.");
  process.exit(0);
}

const batches = restartRunning ? services.map((service) => [service]) : [services];
for (const batch of batches) {
  await composeUpAndWait(["--no-build", "--force-recreate"], batch);
  for (const service of batch) {
    console.log(`${color.green}✓${color.reset} ${service} restarted and ready`);
  }
}
