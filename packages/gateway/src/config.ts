import type { BunPlugin } from "bun";
import { DEFAULT_TRUSTED_PROXIES, trustedProxySet } from "./client-address";
import { appEnv } from "./env";

const port = 3000;
if (appEnv.GATEWAY_INSTANCE_ID)
  console.warn("[deprecation] GATEWAY_INSTANCE_ID is deprecated; remove it to use a random per-process identity.");

export const gatewayRouter = {
  id: appEnv.GATEWAY_INSTANCE_ID || crypto.randomUUID(),
  port,
  baseUrl: `http://gateway:${port}`,
  trustedProxies: trustedProxySet(DEFAULT_TRUSTED_PROXIES),
};

export const plugin = (): BunPlugin => ({ name: "gateway-router-noop", setup: () => undefined });
