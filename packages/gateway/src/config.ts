import type { BunPlugin } from "bun";
import { DEFAULT_TRUSTED_PROXIES, trustedProxySet } from "./client-address";
import { appEnv, DEFAULT_GATEWAY_URL, GATEWAY_PORT } from "./env";

const port = GATEWAY_PORT;
if (appEnv.GATEWAY_INSTANCE_ID)
  console.warn("[deprecation] GATEWAY_INSTANCE_ID is deprecated; remove it to use a random per-process identity.");

export const gatewayRouter = {
  id: appEnv.GATEWAY_INSTANCE_ID || crypto.randomUUID(),
  port,
  baseUrl: appEnv.GATEWAY_INTERNAL_URL,
  internalUrls: [DEFAULT_GATEWAY_URL, appEnv.GATEWAY_INTERNAL_URL],
  trustedProxies: trustedProxySet(DEFAULT_TRUSTED_PROXIES),
};

export const plugin = (): BunPlugin => ({ name: "gateway-router-noop", setup: () => undefined });
