import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import {
  EMPTY_NETWORK_ALLOWLIST,
  isAllowlistedNetworkAddress,
  isUnsafeNetworkAddress,
  isUnsafeNetworkHostname,
  type NetworkAllowlist,
  normalizeNetworkHostname,
  parseNetworkAddress,
} from "../shared/network-address";

export type PublicNetworkAddress = { address: string; family: 4 | 6 };
export type NetworkLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

export class NetworkTargetBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkTargetBlockedError";
  }
}

export const resolveAllowedNetworkAddresses = async (
  rawHostname: string,
  allowlist: NetworkAllowlist,
  lookup: NetworkLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
): Promise<PublicNetworkAddress[]> => {
  const hostname = normalizeNetworkHostname(rawHostname);
  const trustedHost = allowlist.hosts.has(hostname);
  if (!trustedHost && isUnsafeNetworkHostname(rawHostname)) throw new NetworkTargetBlockedError("Network target host is not allowed");

  const literal = parseNetworkAddress(rawHostname);
  const addresses = literal ? [literal] : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("Network target could not be resolved");

  const normalized: PublicNetworkAddress[] = addresses.map((entry) => {
    const literal = parseNetworkAddress(entry.address);
    if (entry.family !== 4 && entry.family !== 6)
      throw new NetworkTargetBlockedError("Network target returned an unsupported address family");
    if (!literal || literal.family !== entry.family) throw new NetworkTargetBlockedError("Network target returned an invalid address");
    return literal;
  });
  if (
    !trustedHost &&
    normalized.some((entry) => isUnsafeNetworkAddress(entry.address) && !isAllowlistedNetworkAddress(allowlist, entry.address))
  ) {
    throw new NetworkTargetBlockedError("Network target resolved to a private or reserved address");
  }
  return normalized;
};

/** Save-time hint only: every request must still resolve, validate and pin its target. */
export const isNetworkTargetBlocked = async (
  hostname: string,
  allowlist: NetworkAllowlist,
  {
    resolve = resolveAllowedNetworkAddresses,
    timeoutMs = 5000,
  }: {
    resolve?: typeof resolveAllowedNetworkAddresses;
    timeoutMs?: number;
  } = {},
): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      resolve(hostname, allowlist),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    return false;
  } catch (error) {
    return error instanceof NetworkTargetBlockedError;
  } finally {
    clearTimeout(timer);
  }
};

export const resolvePublicNetworkAddresses = (rawHostname: string, lookup?: NetworkLookup): Promise<PublicNetworkAddress[]> =>
  resolveAllowedNetworkAddresses(rawHostname, EMPTY_NETWORK_ALLOWLIST, lookup);

/** Socket lookup using only addresses already checked by the public resolver. */
export const pinnedNetworkLookup =
  (addresses: readonly PublicNetworkAddress[]): LookupFunction =>
  (_hostname, options, callback) => {
    const family = options.family === 4 || options.family === 6 ? options.family : 0;
    const candidates = family ? addresses.filter((entry) => entry.family === family) : [...addresses];
    const selected = candidates[0];
    if (!selected) {
      callback(Object.assign(new Error("No validated address for requested IP family"), { code: "ENOTFOUND" }), "", family || undefined);
      return;
    }
    if (options.all) callback(null, candidates);
    else callback(null, selected.address, selected.family);
  };
