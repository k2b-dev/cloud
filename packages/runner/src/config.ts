import { parseAppKey } from "@k2b/cloud/app-key";
import { env } from "@k2b/cloud/config";

/** Consume the existing shared app-identity registry, without bootstrapping installation connections. */
export const runnerEnvironment = async () => {
  const raw = env.CLOUD_APP_KEY;
  if (!raw) throw new Error("CLOUD_APP_KEY or CLOUD_APP_KEY_FILE is required");
  const key = parseAppKey(raw);
  if (key.appId !== "runner") throw new Error("Expected the runner app key");
  const origin = env.CLOUD_CORE_INTERNAL_ORIGIN;
  if (!origin) throw new Error("CLOUD_CORE_INTERNAL_ORIGIN is required");
  return { key, origin };
};
