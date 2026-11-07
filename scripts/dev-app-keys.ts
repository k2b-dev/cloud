#!/usr/bin/env bun
/** Prepare public, development-only private key fixtures before Compose starts Core. */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatAppKey } from "../packages/cloud/src/app-key";
import { DEVELOPMENT_INSTALLATION_ID } from "../packages/cloud/src/runtime/development-keys";
import fixtures from "./fixtures/development-app-keys.json";

export const prepareDevAppKeys = async (root = join(import.meta.dir, "..")): Promise<void> => {
  const directory = join(root, ".local/dev-app-keys");
  await mkdir(directory, { recursive: true });
  for (const key of fixtures.keys) {
    const path = join(directory, `${key.appId}.key`);
    await writeFile(path, `${formatAppKey({ ...key, installationId: DEVELOPMENT_INSTALLATION_ID })}\n`);
    // Public fixtures, intentionally readable by the unprivileged image user.
    await chmod(path, 0o644);
  }
};
if (import.meta.main) {
  if (process.argv.includes("--help"))
    console.log("Usage: bun scripts/dev-app-keys.ts\nPrepare the public, development-only app key fixtures in .local/dev-app-keys.");
  else if (process.argv.length > 2) throw new Error("Use --help for usage");
  else await prepareDevAppKeys();
}
