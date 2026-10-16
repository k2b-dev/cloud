import type { Result } from "@k2b/cloud/server";
import { resolvePulseMessages } from "../messages";

export const localizedScrapeResult = async <T>(result: Result<T> | Promise<Result<T>>, locale: string): Promise<Result<T>> => {
  const resolved = await result;
  if (resolved.ok || resolved.error.code !== "PULSE_SCRAPE_TARGET_BLOCKED") return resolved;
  return { ...resolved, error: { ...resolved.error, message: resolvePulseMessages(locale).t.scrapeTargetBlocked } };
};
