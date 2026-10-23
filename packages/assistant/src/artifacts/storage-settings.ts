import { hasRole } from "@k2b/cloud/contracts";
import { invalidateSettingsCache, SettingUnreadableError, set } from "@k2b/cloud/services/settings";
import { sql } from "bun";
import { z } from "zod";
import { app } from "../config";
import { ArtifactError, type ArtifactIdentity, user } from "./service";

export const StorageSettings = z
  .object({
    fileMiB: z.number().int().min(1).max(64).optional(),
    totalMiB: z.number().int().min(1).max(1048576).optional(),
    replaceUnreadable: z.array(z.enum(["assistant.storage_file_mib", "assistant.storage_total_mib"])).optional(),
  })
  .strict();
function authorize(identity: ArtifactIdentity) {
  if (!hasRole(user(identity), "admin")) throw new ArtifactError("ACCESS_DENIED");
}
export const storageSettings = {
  async read(identity: ArtifactIdentity) {
    authorize(identity);
    const file = await app.settings.read("assistant.storage_file_mib");
    const total = await app.settings.read("assistant.storage_total_mib");
    return {
      fileMiB: file.value,
      totalMiB: total.value,
      unreadable: {
        "assistant.storage_file_mib": file.stored === "unreadable",
        "assistant.storage_total_mib": total.stored === "unreadable",
      },
    };
  },
  async write(value: unknown, identity: ArtifactIdentity) {
    authorize(identity);
    const input = StorageSettings.parse(value);
    const updates = [
      ["assistant.storage_file_mib", input.fileMiB],
      ["assistant.storage_total_mib", input.totalMiB],
    ] as const;
    // Check the entire submission before the first write; omitted fields stay untouched.
    for (const [key, value] of updates) {
      if (value !== undefined && !input.replaceUnreadable?.includes(key) && (await app.settings.read(key)).stored === "unreadable")
        throw new SettingUnreadableError(key);
    }
    await sql.begin(async (tx) => {
      for (const [key, value] of updates) {
        if (value !== undefined) await set(key, value, tx, { replaceUnreadable: input.replaceUnreadable?.includes(key) === true });
      }
    });
    await invalidateSettingsCache(updates.filter(([, value]) => value !== undefined).map(([key]) => key));
    return this.read(identity);
  },
};
