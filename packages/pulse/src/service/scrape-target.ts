import { fail, ok, type Result } from "@k2b/cloud/server";
import { isNetworkTargetBlocked, resolveAllowedNetworkAddresses } from "@k2b/cloud/services/network-security";
import { parseNetworkAllowlistEnv } from "@k2b/cloud/shared";
import { appEnv } from "../env";
import { resolvePulseMessages } from "../messages";

export const scrapeAllowlist = () => parseNetworkAllowlistEnv("PULSE_SCRAPE_ALLOWED_TARGETS", appEnv.PULSE_SCRAPE_ALLOWED_TARGETS);

export const scrapeTargetBlocked = () => ({
  code: "PULSE_SCRAPE_TARGET_BLOCKED",
  status: 400 as const,
  message: resolvePulseMessages("en").t.scrapeTargetBlocked,
});

/** Unreachable endpoints can be saved, but a known policy refusal cannot. */
export const checkScrapeTarget = async (
  endpointUrl: string,
  resolve = resolveAllowedNetworkAddresses,
  timeoutMs = 5000,
): Promise<Result<void>> => {
  const allowlist = scrapeAllowlist();
  let hostname: string;
  try {
    hostname = new URL(endpointUrl).hostname;
  } catch {
    return ok();
  }
  return (await isNetworkTargetBlocked(hostname, allowlist, { resolve, timeoutMs })) ? fail(scrapeTargetBlocked()) : ok();
};
