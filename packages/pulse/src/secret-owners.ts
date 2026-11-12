import { createSecretOwner } from "@k2b/cloud/services";

export const secretOwners = [
  createSecretOwner({ id: "sources", table: "pulse.sources", primaryKey: ["id"], columns: ["bearer_token_encrypted"] }),
  createSecretOwner({ id: "base-stores", table: "pulse.base_stores", primaryKey: ["base_id"], columns: ["read_password_encrypted"] }),
  createSecretOwner({
    id: "dashboard-operations",
    table: "pulse.dashboard_operations",
    primaryKey: ["base_id", "operation_key"],
    columns: ["response"],
  }),
];
