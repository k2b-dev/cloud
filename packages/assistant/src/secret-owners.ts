import { createSecretOwner } from "@k2b/cloud/services";

export const secretOwners = [
  createSecretOwner({
    id: "http-secrets",
    table: "assistant.http_secrets",
    primaryKey: ["user_id", "scope", "name"],
    columns: ["encrypted"],
  }),
  createSecretOwner({ id: "http-calls", table: "assistant.http_calls", primaryKey: ["user_id", "id"], columns: ["encrypted"] }),
  createSecretOwner({
    id: "artifact-machine-secrets",
    table: "assistant.artifact_machine_secrets",
    primaryKey: ["artifact_id", "name"],
    columns: ["encrypted"],
  }),
];
