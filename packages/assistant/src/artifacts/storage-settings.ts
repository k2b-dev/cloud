import { hasRole } from "@k2b/cloud/contracts";
import { z } from "zod";
import { app } from "../config";
import { ArtifactError, type ArtifactIdentity, user } from "./service";

export const StorageSettings = z
  .object({
    fileMiB: z.number().int().min(1).max(64),
    totalMiB: z.number().int().min(1).max(1048576),
  })
  .strict();
function authorize(identity: ArtifactIdentity) {
  if (!hasRole(user(identity), "admin")) throw new ArtifactError("ACCESS_DENIED");
}
export const storageSettings = {
  async read(identity: ArtifactIdentity) {
    authorize(identity);
    return {
      fileMiB: await app.settings.get("assistant.storage_file_mib"),
      totalMiB: await app.settings.get("assistant.storage_total_mib"),
    };
  },
  async write(value: unknown, identity: ArtifactIdentity) {
    authorize(identity);
    const input = StorageSettings.parse(value);
    // complete value from explicit admin input; nothing is merged over a read (#1303)
    await app.settings.set("assistant.storage_file_mib", input.fileMiB, { replaceUnreadable: true });
    // complete value from explicit admin input; nothing is merged over a read (#1303)
    await app.settings.set("assistant.storage_total_mib", input.totalMiB, { replaceUnreadable: true });
    return this.read(identity);
  },
};
