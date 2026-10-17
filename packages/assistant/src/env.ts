import { defineEnv, envList, envString } from "@k2b/cloud/config";

export const appEnv = defineEnv({
  ASSISTANT_RSQL_ALLOWED_TARGETS: {
    schema: envList,
    default: ["rsql"],
    scope: "runtime",
    doc: "Comma-separated host names, IP addresses and CIDR ranges on internal networks allowed for Assistant rsql requests; unset allows public targets and `rsql`, an explicit value replaces this default, and invalid entries including `/0` stop the owning process at startup.",
  },
  CLOUD_CLI_CHROMIUM: {
    schema: envString,
    doc: "Path to a Chromium executable for Assistant code mode when Playwright's bundled browser is unavailable; the assistant image sets `/usr/bin/chromium`.",
  },
});
