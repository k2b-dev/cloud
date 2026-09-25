import { defineEnv } from "@k2b/cloud/config";
import { z } from "zod";

/**
 * Cloud Login's own settings. Postgres and NATS use the platform keys
 * (`DATABASE_URL`, `NATS_SERVERS`, `SYNC_NAMESPACE`, ...) from `@k2b/cloud/config`.
 */
export const appEnv = defineEnv({
  CLOUD_LOGIN_VAPID_PUBLIC_KEY: {
    schema: z.string().regex(/^[A-Za-z0-9_-]{87}$/, "must be an unpadded base64url P-256 public key"),
    doc: "Cloud Login only: VAPID public key for sign-in push notifications; generate the pair once with `bunx web-push generate-vapid-keys`. Unset disables push.",
  },
  CLOUD_LOGIN_VAPID_PRIVATE_KEY: {
    schema: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "must be an unpadded base64url P-256 private key"),
    scope: "secret",
    doc: "Cloud Login only: VAPID private key matching `CLOUD_LOGIN_VAPID_PUBLIC_KEY`; changing it invalidates every phone's push subscription.",
  },
  CLOUD_LOGIN_VAPID_SUBJECT: {
    schema: z.string().refine((value) => /^(mailto:|https:\/\/)/.test(value), "must start with mailto: or https://"),
    doc: "Cloud Login only: operator contact sent to push services, as `mailto:` or `https://` URL.",
  },
});
