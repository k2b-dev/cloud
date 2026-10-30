import { defineEnv, envString } from "@k2b/cloud/config";

import { z } from "zod";

export const appEnv = defineEnv({
  GATEWAY_INGRESS_PORT: {
    schema: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .refine((port) => port !== 3000, "must differ from the public gateway port"),
    default: 3001,
    doc: "Private ingress provider listener for Traefik HTTP discovery and Caddy certificate admission. Keep this port off public ingress and publish no host port.",
  },
  GATEWAY_INSTANCE_ID: {
    schema: envString,
    doc: "Deprecated: remove to use a random per-process gateway identity. An explicit value is still honored for this release.",
  },
});
