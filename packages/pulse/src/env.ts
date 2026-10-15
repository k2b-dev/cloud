import { defineEnv, envList } from "@k2b/cloud/config";

export const appEnv = defineEnv({
  PULSE_SCRAPE_ALLOWED_TARGETS: {
    schema: envList,
    default: [],
    scope: "runtime",
    doc: "Comma-separated host names, IP addresses and CIDR ranges on internal networks that Pulse metrics sources may scrape, for example `prometheus,10.20.0.0/16`; unset allows only public endpoints.",
  },
});
