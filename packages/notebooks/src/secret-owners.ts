import { createSecretOwner } from "@k2b/cloud/services";

export const secretOwners = [
  createSecretOwner({
    id: "s3-snapshots",
    table: "notebooks.s3_snapshot_configs",
    primaryKey: ["notebook_id"],
    columns: ["access_key_id", "secret_access_key"],
  }),
];
