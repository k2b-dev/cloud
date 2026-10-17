import { createHash } from "node:crypto";
import { type AuthContext, ratelimit } from "@k2b/cloud/server";
import type { MiddlewareHandler } from "hono";

const limit = 120;
const limiter = ratelimit({ id: "filesv2-public-upload", prefix: "filesv2:rate-limit", limit, windowSecs: 60 });

export const publicUploadRateLimit: MiddlewareHandler<AuthContext> = async (c, next) => {
  // Keep IP resolution aligned with cloud/src/server/middleware/rate-limit.ts.
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown";
  const tokenHash = createHash("sha256")
    .update(c.req.param("token") ?? "")
    .digest("hex");
  const result = await limiter.check(`share:${tokenHash}:ip:${ip}`);
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
