import { isIP } from "node:net";
import { type AuthContext, ratelimit } from "@k2b/cloud/server";
import type { MiddlewareHandler } from "hono";

/** Start, lease, commit and abort under the mount in index.ts; anything else keeps the page budget of the global limiter. */
export const publicUploadPath = /^\/share\/filesv2\/inbox\/([^/]+)\/api\/uploads(?:\/[^/]+\/(?:lease|commit|abort))?$/;

export const isPublicUpload = (method: string, path: string): boolean => method === "POST" && publicUploadPath.test(path);

export const publicUploadClientBucket = (ip: string): string => {
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
  // One subscriber usually has at least a /64; rotating host addresses must not reset the budget.
  return `ip6:${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
};

const limit = 120;
const limiter = ratelimit({ id: "filesv2-public-upload", prefix: "filesv2:rate-limit", limit, windowSecs: 60 });

export const publicUploadRateLimit: MiddlewareHandler<AuthContext> = async (c, next) => {
  if (!isPublicUpload(c.req.method, c.req.path)) return next();

  // Keep IP resolution aligned with cloud/src/server/middleware/rate-limit.ts.
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown";
  // All links share one client budget: an equal per-link cap is redundant; a larger aggregate would need an invented multiplier.
  const result = await limiter.check(publicUploadClientBucket(ip));
  const resetInSeconds = Math.max(1, Math.ceil(result.resetIn / 1000));

  c.header("X-RateLimit-Limit", String(limit));
  c.header("X-RateLimit-Remaining", String(result.remaining));
  c.header("X-RateLimit-Reset", String(resetInSeconds));
  if (result.limited) {
    c.header("Retry-After", String(resetInSeconds));
    return c.json({ message: "Rate limit exceeded" }, 429);
  }
  await next();
};
