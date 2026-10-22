import { SettingUnreadableError } from "@k2b/cloud/services";
import { z } from "zod";
import { app } from "../config";
import { type ConfigurationInput, ConfigurationSchema, type PublicConfiguration } from "../contracts";
import { FilesError } from "./errors";
import { validateConfiguration } from "./paths";

const StoredSchema = ConfigurationSchema.extend({ token: z.string().max(4096) });
const defaults = {
  activityRetentionDays: 365,
  url: "",
  token: "",
  cloud: {
    autoCreate: false,
    autoArchive: true,
    enabled: false,
    root: "cloud",
    prefix: "",
    homes: "users",
    groups: "groups",
    archive: "archive",
  },
  freeipa: { enabled: false, root: "freeipa", prefix: "", homes: "users", groups: "groups", archive: "archive" },
  collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" as const },
};
export async function readConfiguration(): Promise<PublicConfiguration & { token: string }> {
  const { value, stored } = await app.settings.read("filesv2.configuration");
  if (stored === "unreadable") return { ...defaults, tokenConfigured: false, unreadable: true };
  try {
    const config = StoredSchema.parse(value ? JSON.parse(value) : defaults);
    validateConfiguration(config);
    return { ...config, tokenConfigured: Boolean(config.token), unreadable: false };
  } catch {
    throw new FilesError("invalid_configuration", 503);
  }
}
export async function writeConfiguration(input: ConfigurationInput): Promise<void> {
  let token = input.token;
  if (!token) {
    const current = await readConfiguration();
    if (current.unreadable) throw new FilesError("configuration_unreadable", 409);
    token = current.token;
  }
  const next = StoredSchema.parse({ ...input, token });
  validateConfiguration(next);
  try {
    await app.settings.set("filesv2.configuration", JSON.stringify(next), input.token ? { replaceUnreadable: true } : undefined);
  } catch (error) {
    if (error instanceof SettingUnreadableError) throw new FilesError("configuration_unreadable", 409);
    throw error;
  }
}
export async function resetConfiguration(): Promise<void> {
  await app.settings.remove("filesv2.configuration");
}
