import { parseAppKey } from "../app-key";
import { env } from "../config/env";

/** Identity is independent of where the process obtains its connections. */
export const requireAppKey = (appId: string) => {
  const value = env.CLOUD_APP_KEY;
  if (!value)
    throw new Error(
      `Application "${appId}" requires CLOUD_APP_KEY_FILE (or CLOUD_APP_KEY). See https://cloud.k2b.dev/en/docs/operations/app-keys`,
    );
  const key = parseAppKey(value);
  if (key.appId !== appId) throw new Error("App-key appId does not match the declared application");
  return key;
};
