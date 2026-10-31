import { lstat } from "node:fs/promises";
import { parseAppKey } from "@k2b/cloud/app-key";
import { env } from "@k2b/cloud/config";

/** Consume the existing shared app-identity registry, without bootstrapping installation connections. */
export const runnerEnvironment = async () => {
  const raw = env.CLOUD_APP_KEY;
  const file = process.env.CLOUD_APP_KEY_FILE?.trim();
  if (file) {
    const info = await lstat(file);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o400)
      throw new Error("runner_key_file_requires_supervisor_owner_and_mode_0400");
  }
  if (!raw) throw new Error("CLOUD_APP_KEY or CLOUD_APP_KEY_FILE is required");
  const key = parseAppKey(raw);
  if (key.appId !== "runner") throw new Error("Expected the runner app key");
  const origin = env.CLOUD_CORE_INTERNAL_ORIGIN;
  if (!origin) throw new Error("CLOUD_CORE_INTERNAL_ORIGIN is required");
  return { key, origin };
};
