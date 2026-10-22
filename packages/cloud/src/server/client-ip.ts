import { isIP } from "node:net";
import type { Context } from "hono";

// The gateway (packages/gateway/src/client-address.ts) resolves this address using GATEWAY_TRUSTED_PROXIES.
export const clientIp = (c: Context): string =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown";

/** Stable network key for IP budgets: IPv4 addresses and IPv6 /64 networks. */
export const clientIpBucket = (ip: string): string => {
  if (isIP(ip) !== 6) return `ip:${ip}`;

  const address = ip.replace(/%.*$/, "").replace(/\d+\.\d+\.\d+\.\d+$/, (tail) => {
    const value = tail.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
    return `${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  });
  const [head = "", tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = (address.includes("::") ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left).map(
    (group) => Number.parseInt(group, 16),
  );
  const ipv4 = (high: number, low: number) => `ip:${[high >> 8, high & 255, low >> 8, low & 255].join(".")}`;
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return ipv4(g6, g7);
  // NAT64 (64:ff9b::/96) and Teredo (2001::/32, inverted) carry the client's IPv4 address in the low 32 bits;
  // their /64 names a translator or relay that unrelated clients share.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return ipv4(g6, g7);
  if (g0 === 0x2001 && g1 === 0) return ipv4(g6 ^ 0xffff, g7 ^ 0xffff);
  // 6to4 (2002::/16) gives one IPv4 holder a whole /48; key it by that IPv4 address instead of 65,536 /64 budgets.
  if (g0 === 0x2002) return ipv4(g1 ?? 0, g2 ?? 0);
  // One subscriber usually has at least a /64; rotating host addresses must not reset the budget.
  return `ip6:${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
};
