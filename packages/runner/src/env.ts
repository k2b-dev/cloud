import { parseAppKey } from "@k2b/cloud/app-key";

/** The runner accepts only the standard app identity inputs; never bootstrap installation connections. */
export const runnerEnvironment = async (env: Record<string, string | undefined> = process.env) => {
  if (env.CLOUD_APP_KEY !== undefined && env.CLOUD_APP_KEY_FILE !== undefined)
    throw new Error("Use CLOUD_APP_KEY or CLOUD_APP_KEY_FILE, not both");
  const raw = env.CLOUD_APP_KEY_FILE === undefined ? env.CLOUD_APP_KEY : await Bun.file(env.CLOUD_APP_KEY_FILE).text();
  if (!raw) throw new Error("CLOUD_APP_KEY or CLOUD_APP_KEY_FILE is required");
  const key = parseAppKey(raw.trim());
  if (key.appId !== "runner") throw new Error("Expected the runner app key");
  if (!env.CLOUD_CORE_INTERNAL_ORIGIN) throw new Error("CLOUD_CORE_INTERNAL_ORIGIN is required");
  return { key, origin: env.CLOUD_CORE_INTERNAL_ORIGIN };
};
