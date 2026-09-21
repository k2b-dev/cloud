#!/usr/bin/env bun
/**
 * dev:down [--infra] — remove the application stack. Infrastructure keeps
 * running (and keeps its data) unless `--infra` is given.
 *
 * Orphans and volumes are never removed: the separately composed
 * infrastructure shares the default project name and must survive this.
 */
import { $ } from "bun";
import { COMPOSE_FILE, helpFor, INFRA_COMPOSE_FILE } from "./dev-cli";

const inputs = process.argv.slice(2);
if (inputs.some((input) => input !== "--infra")) {
  helpFor("bun run dev:down [--infra]", [
    "Remove the application containers.",
    "--infra also stops Postgres, Valkey, NATS, and the other infrastructure services.",
  ]);
  process.exit(inputs.includes("--help") ? 0 : 1);
}

await $`docker compose -f ${COMPOSE_FILE} --profile extra down`;
if (inputs.includes("--infra")) await $`docker compose -f ${INFRA_COMPOSE_FILE} down`;
