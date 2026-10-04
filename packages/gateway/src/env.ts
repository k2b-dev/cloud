import { defineEnv, envList, envString } from "@k2b/cloud/config";
import { DEFAULT_TRUSTED_PROXIES } from "./client-address";

export const appEnv = defineEnv({
  GATEWAY_INSTANCE_ID: {
    schema: envString,
    doc: "Stable identity of this gateway router instance in the registry; defaults to `HOSTNAME`, then `gateway-router`.",
  },
  GATEWAY_TRUSTED_PROXIES: {
    schema: envList,
    default: DEFAULT_TRUSTED_PROXIES,
    doc: "Comma-separated IP addresses or CIDR ranges of the reverse proxies allowed to name the client in `X-Forwarded-For`; the default trusts loopback and private networks, which covers Traefik on a Docker network. Set the proxy's exact address or subnet when clients on private networks reach the gateway directly or through a proxy that appends to their `X-Forwarded-For`. An invalid entry stops the gateway at startup.",
  },
});
