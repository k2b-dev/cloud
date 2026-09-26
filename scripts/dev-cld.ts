#!/usr/bin/env bun
/**
 * dev:cld — run this checkout's `cld` source against the local development
 * Cloud with its own configuration.
 *
 *   bun run dev:cld -- <cld arguments>     (`--help` is the CLI's own help)
 *
 * Profiles, OAuth tokens, the plugin store, and locks live under
 * `.local/cld/` in the checkout (gitignored), never in the installed `cld`'s
 * `~/.config/cloud/cld`. A fresh configuration records that no agent skill
 * target was chosen, so the dev CLI writes no skill until someone adds a
 * target with `bun run dev:cld -- skills add <directory>`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const stateDirectory = join(root, ".local", "cld");
const configFile = join(stateDirectory, "config.json");

if (!existsSync(configFile)) {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(configFile, `${JSON.stringify({ skills: { targets: [] } }, null, 2)}\n`, { mode: 0o600 });
}

const child = Bun.spawn(
  [process.execPath, join(root, "packages/cloud-cli/src/index.ts"), "--server", "http://localhost:3000", ...process.argv.slice(2)],
  {
    env: { ...process.env, CLD_CONFIG: configFile, XDG_CONFIG_HOME: stateDirectory },
    stdio: ["inherit", "inherit", "inherit"],
  },
);
process.exit(await child.exited);
