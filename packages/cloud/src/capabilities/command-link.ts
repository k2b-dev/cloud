import { z } from "zod";
import type { CapabilityCommandManifest } from "../contracts/capabilities";
import { CommandLinkSchema, type CommandOptions, commandPath } from "../contracts/commands";
import { publicCloudOrigin } from "../shared/app-url";

export const resolveCommandLink = (
  appId: string,
  command: CapabilityCommandManifest,
  input: unknown,
  options: CommandOptions,
  appUrl: string,
) => {
  const parsed = z.fromJSONSchema(structuredClone(command.inputSchema)).parse(input);
  const path = commandPath(command.path, `${appId}.${command.localId}`, parsed, options);
  return CommandLinkSchema.parse({ href: new URL(path, publicCloudOrigin(appUrl)).href });
};
