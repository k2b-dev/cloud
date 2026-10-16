import { fail, ok, type Result } from "@k2b/cloud/server";
import { NetworkTargetBlockedError, resolveAllowedNetworkAddresses } from "@k2b/cloud/services/network-security";
import { parseNetworkAllowlist } from "@k2b/cloud/shared";
import { appEnv } from "../env";
import { resolvePulseMessages } from "../messages";

export const scrapeAllowlist = () => {
  try {
    return parseNetworkAllowlist(appEnv.PULSE_SCRAPE_ALLOWED_TARGETS);
  } catch (error) {
    throw new Error(`PULSE_SCRAPE_ALLOWED_TARGETS: ${error instanceof Error ? error.message : "Invalid allowlist"}`);
  }
};

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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      resolve(new URL(endpointUrl).hostname, allowlist),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    return ok();
  } catch (error) {
    return error instanceof NetworkTargetBlockedError ? fail(scrapeTargetBlocked()) : ok();
  } finally {
    clearTimeout(timer);
  }
};
