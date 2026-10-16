import { defineEnv, envList } from "@k2b/cloud/config";

export const appEnv = defineEnv({
  NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS: {
    schema: envList,
    default: [],
    scope: "runtime",
    doc: "Comma-separated host names, IP addresses and CIDR ranges on internal networks that notebook S3 snapshots may upload to, for example `minio,10.20.0.0/16`; unset allows only public storage. An entry covers every port on that host or range; `/0` entries and other invalid entries stop Notebooks at startup.",
  },
});
