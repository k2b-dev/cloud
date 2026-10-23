import { audit, SettingUnreadableError, settings } from "@k2b/cloud/services";
import { invalidateSettingsCache } from "@k2b/cloud/services/settings";
import { sql, type TransactionSQL } from "bun";
import { z } from "zod";
import { app } from "../config";
import { type ConfigurationInput, ConfigurationSchema, type PublicConfiguration } from "../contracts";
import type { UserFilesCall } from "./activity";
import { FilesError } from "./errors";
import { validateConfiguration } from "./paths";

const StoredSchema = ConfigurationSchema.extend({ token: z.string().max(4096) });
const key = "filesv2.configuration";
async function recordAudit(tx: TransactionSQL, call: UserFilesCall, action: "update" | "reset") {
  const actor = call.actor.kind === "user" ? call.actor.user : call.actor.delegatedUser;
  await audit.record(
    {
      action: `filesv2.configuration.${action}`,
      outcome: "allowed",
      actor: { userId: actor?.id },
      target: { type: key, id: key },
      requestId: call.requestId,
      metadata: {
        via: call.via,
        calling_app: call.callingApp,
        origin: call.origin,
        invocation_id: call.invocationId,
      },
    },
    tx,
  );
}
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
export async function writeConfiguration(input: ConfigurationInput, call: UserFilesCall): Promise<void> {
  let token = input.token;
  if (!token) {
    const current = await readConfiguration();
    if (current.unreadable) throw new FilesError("configuration_unreadable", 409);
    token = current.token;
  }
  const next = StoredSchema.parse({ ...input, token });
  validateConfiguration(next);
  try {
    await sql.begin(async (tx) => {
      await settings.set(key, JSON.stringify(next), tx, input.token ? { replaceUnreadable: true } : undefined);
      await recordAudit(tx, call, "update");
    });
  } catch (error) {
    if (error instanceof SettingUnreadableError) throw new FilesError("configuration_unreadable", 409);
    throw error;
  }
  await invalidateSettingsCache([key]);
}
export async function resetConfiguration(call: UserFilesCall): Promise<void> {
  await sql.begin(async (tx) => {
    await settings.remove(key, tx);
    await recordAudit(tx, call, "reset");
  });
  await invalidateSettingsCache([key]);
}
