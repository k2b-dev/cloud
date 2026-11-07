import { defineEnv, envSource, envString } from "@k2b/cloud/config";

const appEnv = defineEnv({
  PROVIDER_TOKEN: {
    schema: envString,
    scope: "secret",
    secretFile: true,
    doc: "Provider credential for this application.",
  },
});

export const providerToken = () => ({ value: appEnv.PROVIDER_TOKEN, source: envSource(appEnv, "PROVIDER_TOKEN") });
