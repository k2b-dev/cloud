import { type AuthContext, clientIp, clientIpBucket, ratelimit } from "@k2b/cloud/server";
import type { MiddlewareHandler } from "hono";

/** Start, lease, commit and abort under the mount in index.ts; anything else keeps the page budget of the global limiter. */
export const publicUploadPath = /^\/share\/filesv2\/inbox\/([^/]+)\/api\/uploads(?:\/[^/]+\/(?:lease|commit|abort))?$/;

export const isPublicUpload = (method: string, path: string): boolean => method === "POST" && publicUploadPath.test(path);

const limit = 120;
const limiter = ratelimit({ id: "filesv2-public-upload", prefix: "filesv2:rate-limit", limit, windowSecs: 60 });

export const publicUploadRateLimit: MiddlewareHandler<AuthContext> = async (c, next) => {
  if (!isPublicUpload(c.req.method, c.req.path)) return next();

  const ip = clientIp(c);
  // All links share one client budget: an equal per-link cap is redundant; a larger aggregate would need an invented multiplier.
  const result = await limiter.check(clientIpBucket(ip));
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
