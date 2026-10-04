/**
 * Client address resolution for requests entering the gateway.
 *
 * Apps key rate limits and audit records on the first `X-Forwarded-For`
 * address. The gateway is the only public entry, so it decides that address:
 * it accepts forwarded hops only from configured trusted proxies, walks the
 * chain from the right, and takes the first address that is not a trusted
 * proxy as the client. Hops to the left of that address came from the client
 * itself and are dropped, so a client never chooses its own address.
 */
import { BlockList, isIP } from "node:net";

export type ClientAddress = {
  /** The resolved client, also forwarded as `X-Real-IP`. */
  address: string;
  /** `X-Forwarded-For` for the upstream: the client, then each trusted hop up to the gateway's peer. */
  forwardedFor: string;
};

/** Loopback and private networks; covers a reverse proxy on a Docker or host-local network. */
export const DEFAULT_TRUSTED_PROXIES = ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"];

type Range = { address: string; prefix: number; family: "ipv4" | "ipv6" };

/** Parses `address` or `address/prefix`; `null` when malformed. */
const parseRange = (entry: string): Range | null => {
  const [address = "", prefix, ...rest] = entry.split("/");
  if (rest.length > 0 || address.includes("%")) return null;
  const version = isIP(address);
  if (version === 0) return null;
  const max = version === 4 ? 32 : 128;
  if (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) return null;
  const bits = prefix === undefined ? max : Number(prefix);
  if (bits > max) return null;
  return { address, prefix: bits, family: version === 4 ? "ipv4" : "ipv6" };
};

/** Builds the trusted-proxy set; throws on a malformed entry so a typo never trusts the wrong peers. */
export const trustedProxySet = (entries: readonly string[]): BlockList => {
  const set = new BlockList();
  for (const entry of entries) {
    const range = parseRange(entry);
    if (!range) throw new Error(`GATEWAY_TRUSTED_PROXIES entry "${entry}" is not an IP address or CIDR range`);
    set.addSubnet(range.address, range.prefix, range.family);
  }
  return set;
};

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Canonical form of one address, or `null` when it is not a bare IP address (ports, brackets and names are rejected). */
const normalizeAddress = (value: string): string | null => {
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;
  // Bun reports IPv4 peers on a dual-stack socket as `::ffff:a.b.c.d`;
  // forward the IPv4 form so one client keeps one rate-limit key.
  return value.match(IPV4_MAPPED)?.[1] ?? value.toLowerCase();
};

const isTrusted = (trusted: BlockList, address: string): boolean => trusted.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");

/**
 * Resolves the client of a request from its `X-Forwarded-For` header and the
 * address of the gateway's direct peer. Returns `null` when the peer address
 * is unknown; the caller then forwards no client address at all.
 *
 * A malformed hop ends the walk: the right-most address the trusted chain
 * still vouches for becomes the client.
 */
export const resolveClientAddress = (forwardedFor: string | null, peer: string | null, trusted: BlockList): ClientAddress | null => {
  const peerAddress = peer === null ? null : normalizeAddress(peer);
  if (peerAddress === null) return null;
  const chain = [peerAddress];
  if (forwardedFor && isTrusted(trusted, peerAddress)) {
    const hops = forwardedFor.split(",");
    for (let index = hops.length - 1; index >= 0; index--) {
      const hop = normalizeAddress(hops[index]!.trim());
      if (hop === null) break;
      chain.unshift(hop);
      if (!isTrusted(trusted, hop)) break;
    }
  }
  return { address: chain[0]!, forwardedFor: chain.join(", ") };
};
