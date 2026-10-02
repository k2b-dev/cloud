import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { domainToASCII } from "node:url";
import type { MailEndpoint } from "../../contracts";

type ResolvedAddress = { address: string; family: 4 | 6 };

export type ResolvedEndpoint = MailEndpoint & {
  host: string;
  addresses: ResolvedAddress[];
};

export class EndpointPolicyError extends Error {
  constructor(
    message: string,
    // A lookup that timed out says nothing about the host, so it keeps its own code and can be retried.
    readonly code: "ENDPOINT_BLOCKED" | "ENDPOINT_DNS_TIMEOUT" = "ENDPOINT_BLOCKED",
  ) {
    super(message);
    this.name = "EndpointPolicyError";
  }
}

const parseIpv4 = (address: string): number | null => {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^(0|[1-9]\d{0,2})$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets.reduce((value, octet) => (value << 8) | octet, 0) >>> 0;
};

const ipv4InCidr = (address: number, base: number, prefix: number): boolean => {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (base & mask);
};

const BLOCKED_IPV4_RANGES = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

const parseIpv6 = (input: string): bigint | null => {
  let address = input.toLowerCase();
  if (address.includes("%") || isIP(address) !== 6) return null;

  if (address.includes(".")) {
    const separator = address.lastIndexOf(":");
    const ipv4 = parseIpv4(address.slice(separator + 1));
    if (separator < 0 || ipv4 === null) return null;
    address = `${address.slice(0, separator)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
};

const ipv6InCidr = (address: bigint, base: bigint, prefix: number): boolean =>
  prefix === 0 || address >> BigInt(128 - prefix) === base >> BigInt(128 - prefix);

const IPV6_BASES = {
  unspecified: 0n,
  loopback: 1n,
  ipv4Mapped: parseIpv6("::ffff:0:0") ?? 0n,
  nat64WellKnown: parseIpv6("64:ff9b::") ?? 0n,
  nat64Local: parseIpv6("64:ff9b:1::") ?? 0n,
  discard: parseIpv6("100::") ?? 0n,
  teredo: parseIpv6("2001::") ?? 0n,
  benchmarking: parseIpv6("2001:2::") ?? 0n,
  orchid: parseIpv6("2001:10::") ?? 0n,
  orchidV2: parseIpv6("2001:20::") ?? 0n,
  documentation: parseIpv6("2001:db8::") ?? 0n,
  sixToFour: parseIpv6("2002::") ?? 0n,
  documentationV2: parseIpv6("3fff::") ?? 0n,
  globalUnicast: parseIpv6("2000::") ?? 0n,
  uniqueLocal: parseIpv6("fc00::") ?? 0n,
  linkLocal: parseIpv6("fe80::") ?? 0n,
  siteLocal: parseIpv6("fec0::") ?? 0n,
  multicast: parseIpv6("ff00::") ?? 0n,
};

const embeddedIpv4 = (address: bigint): string =>
  `${Number((address >> 24n) & 0xffn)}.${Number((address >> 16n) & 0xffn)}.${Number((address >> 8n) & 0xffn)}.${Number(address & 0xffn)}`;

export const isPublicIpAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) {
    const parsed = parseIpv4(address);
    if (parsed === null) return false;
    return !BLOCKED_IPV4_RANGES.some(([base, prefix]) => {
      const parsedBase = parseIpv4(base);
      return parsedBase !== null && ipv4InCidr(parsed, parsedBase, prefix);
    });
  }
  if (family !== 6) return false;

  const parsed = parseIpv6(address);
  if (parsed === null || parsed === IPV6_BASES.unspecified || parsed === IPV6_BASES.loopback) return false;
  if (ipv6InCidr(parsed, IPV6_BASES.ipv4Mapped, 96)) {
    return isPublicIpAddress(embeddedIpv4(parsed));
  }
  if (ipv6InCidr(parsed, IPV6_BASES.nat64WellKnown, 96)) {
    return isPublicIpAddress(embeddedIpv4(parsed));
  }
  return !(
    !ipv6InCidr(parsed, IPV6_BASES.globalUnicast, 3) ||
    ipv6InCidr(parsed, IPV6_BASES.nat64Local, 48) ||
    ipv6InCidr(parsed, IPV6_BASES.discard, 64) ||
    ipv6InCidr(parsed, IPV6_BASES.teredo, 32) ||
    ipv6InCidr(parsed, IPV6_BASES.benchmarking, 48) ||
    ipv6InCidr(parsed, IPV6_BASES.orchid, 28) ||
    ipv6InCidr(parsed, IPV6_BASES.orchidV2, 28) ||
    ipv6InCidr(parsed, IPV6_BASES.documentation, 32) ||
    ipv6InCidr(parsed, IPV6_BASES.sixToFour, 16) ||
    ipv6InCidr(parsed, IPV6_BASES.documentationV2, 20) ||
    ipv6InCidr(parsed, IPV6_BASES.uniqueLocal, 7) ||
    ipv6InCidr(parsed, IPV6_BASES.linkLocal, 10) ||
    ipv6InCidr(parsed, IPV6_BASES.siteLocal, 10) ||
    ipv6InCidr(parsed, IPV6_BASES.multicast, 8)
  );
};

const normalizeHost = (rawHost: string): string => {
  const trimmed = rawHost.trim().replace(/\.$/, "").toLowerCase();
  if (!trimmed || trimmed.length > 253 || /[\s/@\\]/.test(trimmed)) throw new EndpointPolicyError("Invalid endpoint host");

  const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (isIP(unbracketed)) return unbracketed;
  if (unbracketed.includes(":")) throw new EndpointPolicyError("Invalid endpoint host");

  const ascii = domainToASCII(unbracketed);
  if (!ascii || ascii.length > 253) throw new EndpointPolicyError("Invalid endpoint host");
  const labels = ascii.split(".");
  if (labels.some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new EndpointPolicyError("Invalid endpoint host");
  }

  const blockedNames = ["localhost", "localhost.localdomain", "metadata", "metadata.google.internal", "instance-data"];
  if (
    blockedNames.includes(ascii) ||
    ascii.endsWith(".localhost") ||
    ascii.endsWith(".local") ||
    ascii.endsWith(".internal") ||
    ascii.endsWith(".home.arpa")
  ) {
    throw new EndpointPolicyError("Endpoint host is not publicly routable");
  }
  return ascii;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new EndpointPolicyError("Endpoint DNS lookup timed out", "ENDPOINT_DNS_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const resolvePublicEndpoint = async (endpoint: MailEndpoint, timeoutMs = 5_000): Promise<ResolvedEndpoint> => {
  const host = normalizeHost(endpoint.host);
  const literalFamily = isIP(host);
  const resolved = literalFamily
    ? [{ address: host, family: literalFamily as 4 | 6 }]
    : await withTimeout(lookup(host, { all: true, verbatim: true }), timeoutMs);
  const addresses = [...new Map(resolved.map((entry) => [entry.address, entry])).values()].map((entry) => ({
    address: entry.address,
    family: entry.family as 4 | 6,
  }));
  if (addresses.length === 0) throw new EndpointPolicyError("Endpoint host did not resolve");
  if (addresses.some((entry) => !isPublicIpAddress(entry.address))) {
    throw new EndpointPolicyError("Endpoint host resolved to a non-public address");
  }
  return { ...endpoint, host, addresses };
};

export const createPinnedLookup =
  (endpoint: ResolvedEndpoint): LookupFunction =>
  (_hostname, options, callback) => {
    const family = options.family === 4 || options.family === 6 ? options.family : 0;
    const candidates = family ? endpoint.addresses.filter((entry) => entry.family === family) : endpoint.addresses;
    if (candidates.length === 0) {
      const error = Object.assign(new Error("No validated address for requested IP family"), { code: "ENOTFOUND" });
      callback(error, "", family || undefined);
      return;
    }
    if (options.all) {
      callback(null, candidates);
      return;
    }
    const selected = candidates[0];
    if (!selected) {
      callback(Object.assign(new Error("No validated address"), { code: "ENOTFOUND" }), "", family || undefined);
      return;
    }
    callback(null, selected.address, selected.family);
  };
