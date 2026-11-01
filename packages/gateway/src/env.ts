import { defineEnv, envString } from "@k2b/cloud/config";

import { z } from "zod";

export const GATEWAY_PORT = 3000;
export const DEFAULT_GATEWAY_URL = `http://gateway:${GATEWAY_PORT}`;

export const appEnv = defineEnv({
  GATEWAY_INTERNAL_URL: {
    schema: z.url().refine((value) => {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
      );
    }, "must be an HTTP(S) origin reachable from ingress"),
    default: DEFAULT_GATEWAY_URL,
    doc: "Gateway origin advertised to private ingress discovery. Use a unique private network alias when several installations share an ingress network. Also recognized as an internal Cloud host.",
  },
  GATEWAY_INGRESS_ENTRYPOINT: {
    schema: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    default: "websecure",
    doc: "Traefik entrypoint for app-domain routers emitted by the private HTTP provider. Must name a configured HTTPS entrypoint.",
  },
  GATEWAY_INGRESS_PORT: {
    schema: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .refine((port) => port !== GATEWAY_PORT, "must differ from the public gateway port"),
    default: 3001,
    doc: "Private ingress provider listener for Traefik HTTP discovery and Caddy certificate admission. Keep this port off public ingress and publish no host port.",
  },
  GATEWAY_INSTANCE_ID: {
    schema: envString,
    doc: "Deprecated: remove to use a random per-process gateway identity. An explicit value is still honored for this release.",
  },
});
