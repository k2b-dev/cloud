import { defineEnv, envString } from "@k2b/cloud/config";

export const appEnv = defineEnv({
  GATEWAY_INSTANCE_ID: {
    schema: envString,
    doc: "Stable identity of this gateway router instance in the registry; defaults to `HOSTNAME`, then `gateway-router`.",
  },
});
