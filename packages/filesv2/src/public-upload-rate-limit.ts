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
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `ip:${groups
      .slice(6)
      .flatMap((group) => [group >> 8, group & 255])
      .join(".")}`;
  }
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
