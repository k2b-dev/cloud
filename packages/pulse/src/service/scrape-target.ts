import { fail, ok, type Result } from "@k2b/cloud/server";
import { isNetworkTargetBlocked, resolveAllowedNetworkAddresses } from "@k2b/cloud/services/network-security";
import { EMPTY_NETWORK_ALLOWLIST, normalizeNetworkHostname, parseNetworkAllowlist } from "@k2b/cloud/shared";
import { sql } from "bun";
import { resolvePulseMessages } from "../messages";

export const baseScrapeAllowlist = async (baseId?: string, db: typeof sql = sql) => {
  if (!baseId) return EMPTY_NETWORK_ALLOWLIST;
  const rows = await db<{ entry: string }[]>`SELECT entry FROM pulse.base_internal_targets WHERE base_id=${baseId}::uuid`;
  return parseNetworkAllowlist(rows.map((row) => row.entry));
};
export const scrapeTargetBlocked = (hostname: string) => ({
  code: "PULSE_SCRAPE_TARGET_BLOCKED",
  status: 400 as const,
  message: `${normalizeNetworkHostname(hostname)} ${resolvePulseMessages("en").t.scrapeTargetBlocked}`,
});
/** Unreachable endpoints can be saved; every scrape still re-resolves and pins each hop. */
export const checkScrapeTarget = async (
  endpointUrl: string,
  baseId?: string,
  resolve = resolveAllowedNetworkAddresses,
  timeoutMs = 5000,
  db: typeof sql = sql,
): Promise<Result<void>> => {
  let url: URL;
  try {
    url = new URL(endpointUrl);
  } catch {
    return ok();
  }
  const allowlist = await baseScrapeAllowlist(baseId, db);
  return (await isNetworkTargetBlocked(url.hostname, allowlist, {
    resolve,
    timeoutMs,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
  }))
    ? fail(scrapeTargetBlocked(url.hostname))
    : ok();
};
