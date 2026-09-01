import { ratelimit } from "@k2b/sync";
import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { MessageResponse } from "../../contracts/shared";
import * as settings from "../../services/settings";
import { type AuthContext, auth } from "./auth";

export type RateLimitRouteOverride = {
  method?: string;
  path: string | RegExp;
  limitPerSecond?: number;
  disabled?: boolean;
};

export type RateLimitConfig = {
  limitPerSecond?: number;
  windowSecs?: number;
  keyBy?: "auto" | "ip" | "user";
  routes?: RateLimitRouteOverride[];
};

type ResolvedRateLimit = {
  disabled: boolean;
  limitPerSecond: number;
  windowSecs: number;
};

const DEFAULT_WINDOW_SECS = 1;
const LIMITER_PREFIX = "cloud:rate-limit";
const limiterCache = new Map<string, ReturnType<typeof ratelimit>>();

const getClientIp = (c: Context): string =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown";

const pathMatches = (requestPath: string, matcher: string | RegExp): boolean => {
  if (matcher instanceof RegExp) return matcher.test(requestPath);
  return requestPath === matcher || requestPath.startsWith(`${matcher}/`);
};

const resolveRouteOverride = (c: Context, overrides: RateLimitRouteOverride[] | undefined): RateLimitRouteOverride | undefined => {
  if (!overrides || overrides.length === 0) return undefined;
  return overrides.find((override) => {
    if (override.method && override.method.toUpperCase() !== c.req.method.toUpperCase()) {
      return false;
    }
    return pathMatches(c.req.path, override.path);
  });
};

const resolveConfig = async (c: Context, config: RateLimitConfig): Promise<ResolvedRateLimit> => {
  const override = resolveRouteOverride(c, config.routes);
  if (override?.disabled) {
    return {
      disabled: true,
      limitPerSecond: 0,
      windowSecs: config.windowSecs ?? DEFAULT_WINDOW_SECS,
    };
  }

  const configuredLimit = override?.limitPerSecond ?? config.limitPerSecond ?? null;
  const limitPerSecond = configuredLimit ?? (await settings.get<number>("security.rate_limit_per_second"));

  return {
    disabled: false,
    limitPerSecond: Math.max(1, Math.floor(limitPerSecond)),
    windowSecs: Math.max(1, Math.floor(config.windowSecs ?? DEFAULT_WINDOW_SECS)),
  };
};

const getLimiter = (limitPerSecond: number, windowSecs: number) => {
  const cacheKey = `${limitPerSecond}:${windowSecs}`;
  const cached = limiterCache.get(cacheKey);
  if (cached) return cached;

  const limiter = ratelimit({
    id: cacheKey,
    limit: limitPerSecond,
    windowSecs,
    prefix: LIMITER_PREFIX,
  });
  limiterCache.set(cacheKey, limiter);
  return limiter;
};

const resolveIdentifier = async (c: Context<AuthContext>, keyBy: RateLimitConfig["keyBy"]): Promise<string> => {
  if (keyBy === "ip") return `ip:${getClientIp(c)}`;

  const token = auth.session.getToken(c);
  if (!token) return `ip:${getClientIp(c)}`;

  const userId = await auth.session.getRequestSubject(c, token);
  if (!userId) return `ip:${getClientIp(c)}`;

  return `user:${userId}`;
};

/**
 * Stateless per-route rate limiting middleware backed by @k2b/sync.
 * Keying defaults to user ID (when session exists), otherwise client IP.
 */
export const rateLimit = (config: RateLimitConfig = {}): MiddlewareHandler<AuthContext> =>
  createMiddleware<AuthContext>(async (c, next) => {
    const resolved = await resolveConfig(c, config);
    if (resolved.disabled) {
      await next();
      return;
    }

    const keyBy = config.keyBy ?? "auto";
    const identifier = await resolveIdentifier(c, keyBy);
    const limiter = getLimiter(resolved.limitPerSecond, resolved.windowSecs);
    const result = await limiter.check(identifier);
    const resetInSeconds = Math.max(1, Math.ceil(result.resetIn / 1000));

    c.header("X-RateLimit-Limit", String(resolved.limitPerSecond));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    c.header("X-RateLimit-Reset", String(resetInSeconds));

    if (result.limited) {
      c.header("Retry-After", String(resetInSeconds));
      return c.json({ message: "Rate limit exceeded" } as MessageResponse, 429);
    }

    await next();
  });
