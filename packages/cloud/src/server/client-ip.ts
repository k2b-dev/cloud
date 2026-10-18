import type { Context } from "hono";

// The gateway (packages/gateway/src/client-address.ts) resolves this address using GATEWAY_TRUSTED_PROXIES.
export const clientIp = (c: Context): string =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown";
