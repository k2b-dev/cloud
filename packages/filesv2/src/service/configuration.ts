import { z } from "zod";
import { app } from "../config";
import { type ConfigurationInput, ConfigurationSchema, type PublicConfiguration } from "../contracts";
import { FilesError } from "./errors";
import { validateConfiguration } from "./paths";

const StoredSchema = ConfigurationSchema.extend({ token: z.string().max(4096) });
const defaults = {
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
};
export async function readConfiguration(): Promise<PublicConfiguration & { token: string }> {
  const value = await app.settings.get("filesv2.configuration");
  try {
    const config = StoredSchema.parse(value ? JSON.parse(value) : defaults);
    validateConfiguration(config);
    return { ...config, tokenConfigured: Boolean(config.token) };
  } catch {
    throw new FilesError("invalid_configuration", 503);
  }
}
export async function writeConfiguration(input: ConfigurationInput): Promise<void> {
  const current = await readConfiguration();
  const next = StoredSchema.parse({ ...input, token: input.token || current.token });
  validateConfiguration(next);
  await app.settings.set("filesv2.configuration", JSON.stringify(next));
}
