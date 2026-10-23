import { logger } from "./logging";
import { requestCacheRedis } from "./request-cache-redis";

const KEY = "cloud:app-access:denied";
let lastFailureLog = -Infinity;

/** Count denied entry/invocation attempts, never discovery filtering or audit rows. Call only for registered app IDs. */
export const recordAppAccessDenied = (appId: string): void => {
  void requestCacheRedis()
    .then((redis) => redis.send("HINCRBY", [KEY, appId, "1"]))
    .catch(() => {
      if (Date.now() - lastFailureLog < 60_000) return;
      lastFailureLog = Date.now();
      logger("app-access").warn("Application access denial metrics are unavailable");
    });
};

/** The metric collector reads only the current registry's bounded set of app labels. */
export const readAppAccessDenials = async (appIds: readonly string[]): Promise<{ app: string; count: number }[]> => {
  if (!appIds.length) return [];
  const values: unknown = await (await requestCacheRedis()).send("HMGET", [KEY, ...appIds]);
  if (!Array.isArray(values)) throw new Error("Invalid application access metrics response");
  return appIds.map((app, index) => ({ app, count: Number(values[index] ?? 0) }));
};
