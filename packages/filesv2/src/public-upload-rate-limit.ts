import { createHash } from "node:crypto";
import { type AuthContext, ratelimit } from "@k2b/cloud/server";
import type { MiddlewareHandler } from "hono";

/** Start, lease, commit and abort under the mount in index.ts; anything else keeps the page budget of the global limiter. */
export const publicUploadPath = /^\/share\/filesv2\/inbox\/([^/]+)\/api\/uploads(?:\/[^/]+\/(?:lease|commit|abort))?$/;

export const publicUploadToken = (method: string, path: string): string | null => {
  if (method !== "POST") return null;
  const segment = publicUploadPath.exec(path)?.[1];
  if (segment === undefined) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const limit = 120;
const limiter = ratelimit({ id: "filesv2-public-upload", prefix: "filesv2:rate-limit", limit, windowSecs: 60 });

export const publicUploadRateLimit: MiddlewareHandler<AuthContext> = async (c, next) => {
  const token = publicUploadToken(c.req.method, c.req.path);
  if (token === null) return next();

  // Keep IP resolution aligned with cloud/src/server/middleware/rate-limit.ts.
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown";
  const tokenHash = createHash("sha256").update(token).digest("hex");
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
