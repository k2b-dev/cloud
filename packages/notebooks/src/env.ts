import { defineEnv, envList } from "@k2b/cloud/config";

export const appEnv = defineEnv({
  NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS: {
    schema: envList,
    default: [],
    scope: "runtime",
    doc: "Comma-separated host names, IP addresses and CIDR ranges on internal networks that notebook S3 snapshots may upload to, for example `minio,10.20.0.0/16`; unset allows only public storage. Bare entries cover every port; host:port and [ipv6]:port restrict a host or IP to one port; `/0` entries and other invalid entries stop Notebooks at startup.",
  },
});
