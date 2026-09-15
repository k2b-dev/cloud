import { z } from "zod";
import { hasRole } from "@k2b/cloud/contracts";
import { app } from "../config";
import { ArtifactError, user, type ArtifactIdentity } from "./service";

export const StorageSettings = z.object({
  fileMiB: z.number().int().min(1).max(64),
  totalMiB: z.number().int().min(1).max(1048576),
}).strict();
function authorize(identity: ArtifactIdentity) {
  if (!hasRole(user(identity),"admin")) throw new ArtifactError("ACCESS_DENIED");
}
export const storageSettings = {
  async read(identity: ArtifactIdentity) {
    authorize(identity);
    return {fileMiB:await app.settings.get("assistant.storage_file_mib"),totalMiB:await app.settings.get("assistant.storage_total_mib")};
  },
  async write(value: unknown, identity: ArtifactIdentity) {
    authorize(identity);
    const input=StorageSettings.parse(value);
    await app.settings.set("assistant.storage_file_mib",input.fileMiB);
    await app.settings.set("assistant.storage_total_mib",input.totalMiB);
    return this.read(identity);
  },
};
