#!/usr/bin/env bun
/**
 * dev [--full] — start the infrastructure stack, then the application stack
 * in the foreground. `--full` also starts the optional `extra` profile.
 */
import { $ } from "bun";
import { COMPOSE_FILE, ensureInfra, helpFor } from "./dev-cli";

const inputs = process.argv.slice(2);
if (inputs.some((input) => input !== "--full")) {
  helpFor("bun run dev [--full]", [
    "Start infrastructure and the core application stack.",
    "--full also starts every optional application.",
  ]);
  process.exit(inputs.includes("--help") ? 0 : 1);
}

await ensureInfra();
const profile = inputs.includes("--full") ? ["--profile", "extra"] : [];
await $`docker compose -f ${COMPOSE_FILE} ${profile} up --build`;
