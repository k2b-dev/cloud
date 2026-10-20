import { z } from "zod";
import type { CapabilityCommandManifest } from "../contracts/capabilities";

/** Shared discovery rule for the palette and composers; it grants no access to the destination. */
export const discoverableCommandInput = (command: CapabilityCommandManifest, appId: string, appIds: ReadonlySet<string>) =>
  appIds.has(appId) ? z.fromJSONSchema(structuredClone(command.inputSchema)).safeParse({}) : undefined;
