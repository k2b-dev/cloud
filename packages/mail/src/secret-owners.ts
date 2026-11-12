import { createSecretOwner } from "@k2b/cloud/services";

export const secretOwners = [
  createSecretOwner({ id: "provider-connections", table: "mail.provider_connections", primaryKey: ["id"], columns: ["encrypted_secret"] }),
  createSecretOwner({
    id: "sender-identity-transports",
    table: "mail.sender_identity_transports",
    primaryKey: ["sender_identity_id"],
    columns: ["encrypted_secret"],
  }),
];
