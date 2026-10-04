import { env } from "@k2b/cloud/config";
import type { BunPlugin } from "bun";
import { trustedProxySet } from "./client-address";
import { appEnv } from "./env";

const port = 3000;

export const gatewayRouter = {
  id: appEnv.GATEWAY_INSTANCE_ID || env.HOSTNAME || "gateway-router",
  port,
  baseUrl: `http://gateway:${port}`,
  trustedProxies: trustedProxySet(appEnv.GATEWAY_TRUSTED_PROXIES),
};

export const plugin = (): BunPlugin => ({ name: "gateway-router-noop", setup: () => undefined });
