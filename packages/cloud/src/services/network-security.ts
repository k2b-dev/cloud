import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { isUnsafeNetworkAddress, isUnsafeNetworkHostname, normalizeNetworkHostname, parseNetworkAddress } from "../shared/network-address";

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

export const resolvePublicNetworkAddresses = async (
  rawHostname: string,
  lookup: NetworkLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
): Promise<PublicNetworkAddress[]> => {
  const hostname = normalizeNetworkHostname(rawHostname);
  if (isUnsafeNetworkHostname(rawHostname)) throw new NetworkTargetBlockedError("Network target host is not allowed");

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
  if (normalized.some((entry) => isUnsafeNetworkAddress(entry.address))) {
    throw new NetworkTargetBlockedError("Network target resolved to a private or reserved address");
  }
  return normalized;
};

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
