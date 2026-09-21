import { env } from "@k2b/cloud/config";
import type { BunPlugin } from "bun";
import { appEnv } from "./env";

const port = 3000;

export const gatewayRouter = {
  id: appEnv.GATEWAY_INSTANCE_ID || env.HOSTNAME || "gateway-router",
  port,
  baseUrl: `http://gateway:${port}`,
};

export const plugin = (): BunPlugin => ({ name: "gateway-router-noop", setup: () => undefined });
