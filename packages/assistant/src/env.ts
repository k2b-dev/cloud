import { defineEnv, envString } from "@k2b/cloud/config";

export const appEnv = defineEnv({
  CLOUD_CLI_CHROMIUM: {
    schema: envString,
    doc: "Path to a Chromium executable for Assistant code mode when Playwright's bundled browser is unavailable; the assistant image sets `/usr/bin/chromium`.",
  },
});
