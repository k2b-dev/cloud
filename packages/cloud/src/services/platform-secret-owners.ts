import { createSecretOwner } from "./secret-owners";
import { invalidateSettingsCache } from "./settings/store";

/** Core alone maintains platform-owned ciphertext, including settings of retired apps. */
export const platformSecretOwners = () => [
  createSecretOwner({
    id: "settings.entries",
    table: "settings.entries",
    primaryKey: ["key"],
    columns: ["value"],
    invalidate: (row) => invalidateSettingsCache(row.key),
  }),
  createSecretOwner({ id: "ai.provider-credentials", table: "ai.provider_credentials", primaryKey: ["provider_id"], columns: ["secret"] }),
  createSecretOwner({ id: "ai.provider-headers", table: "ai.provider_request_headers", primaryKey: ["provider_id"], columns: ["secret"] }),
  createSecretOwner({
    id: "outgoing-mail.profiles",
    table: "outgoing_mail.profiles",
    primaryKey: ["id"],
    columns: ["smtp_password_encrypted", "imap_password_encrypted"],
  }),
  createSecretOwner({ id: "notifications.endpoints", table: "notifications.endpoints", primaryKey: ["id"], columns: ["secret_encrypted"] }),
  createSecretOwner({
    id: "notifications.deliveries",
    table: "notifications.deliveries",
    primaryKey: ["id"],
    columns: ["payload_encrypted"],
  }),
  createSecretOwner({
    id: "platform.storage-buckets",
    table: "platform.storage_buckets",
    primaryKey: ["id"],
    columns: ["credentials_encrypted"],
  }),
];
