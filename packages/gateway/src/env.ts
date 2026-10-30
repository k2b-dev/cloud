import { defineEnv, envString } from "@k2b/cloud/config";

export const appEnv = defineEnv({
  GATEWAY_INSTANCE_ID: {
    schema: envString,
    doc: "Deprecated: remove to use a random per-process gateway identity. An explicit value is still honored for this release.",
  },
});
