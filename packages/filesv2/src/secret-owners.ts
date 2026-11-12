import { createSecretOwner } from "@k2b/cloud/services";

export const secretOwners = [
  createSecretOwner({ id: "transfer-tickets", table: "filesv2.transfer_tickets", primaryKey: ["digest"], columns: ["payload"] }),
];
