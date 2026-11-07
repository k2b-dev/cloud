import { BlockList, isIP } from "node:net";
import { parseNetworkAllowlist } from "../../shared/network-address";

export const DEFAULT_TRUSTED_PROXIES = ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"];

/** One parser for admin writes and the gateway's startup check. */
export const trustedProxySet = (entries: readonly string[]): BlockList => {
  const set = new BlockList();
  for (const entry of entries) {
    const [address = "", prefix, ...rest] = entry.split("/");
    const version = isIP(address);
    const max = version === 4 ? 32 : 128;
    if (!version || rest.length || address.includes("%") || (prefix !== undefined && !/^\d{1,3}$/.test(prefix)))
      throw new Error("Trusted proxies must contain only IP addresses or CIDR ranges");
    const bits = prefix === undefined ? max : Number(prefix);
    if (bits < 1 || bits > max) throw new Error("Trusted proxy CIDR prefixes must be greater than zero and within the address width");
    set.addSubnet(address, bits, version === 4 ? "ipv4" : "ipv6");
  }
  return set;
};

export const validateTrustedProxies = (value: unknown): string | undefined => {
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string"))
    return "Trusted proxies must be a list of strings";
  try {
    trustedProxySet(value);
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid trusted proxies";
  }
};

export const validateNetworkAllowlist = (value: unknown): string | undefined => {
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string"))
    return "Network targets must be a list of strings";
  try {
    parseNetworkAllowlist(value);
  } catch {
    return "Network targets must be exact host names, IP addresses or canonical CIDRs; /0 is forbidden. Host:port and [ipv6]:port are supported.";
  }
};
