import { createHash } from "node:crypto";
import { z } from "zod";
import { CapabilityAppIdSchema } from "../contracts/capabilities";

// Core NATS request/reply only: no JetStream subject, KV value, or retained raw token.
export const workloadSubject = (namespace: string): string => `cloud.workload.${createHash("sha256").update(namespace).digest("hex")}.v1`;
export const WORKLOAD_CHECK_INTERVAL_MS = 60_000;
export const WORKLOAD_REQUEST_TIMEOUT_MS = 5_000;
export const WORKLOAD_LIFETIME_MS = 60 * 60_000;
export const WORKLOAD_ROTATE_BEFORE_MS = WORKLOAD_LIFETIME_MS / 2;

export const WorkloadRequestSchema = z
  .object({
    operation: z.enum(["refresh", "release"]),
    appId: CapabilityAppIdSchema,
    instanceId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    credentialId: z.uuid().nullable(),
  })
  .strict();
export type WorkloadRequest = z.infer<typeof WorkloadRequestSchema>;

export const WorkloadResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("issued"),
      appId: CapabilityAppIdSchema,
      instanceId: z.string(),
      credentialId: z.uuid(),
      token: z.string().regex(/^cld_[a-f0-9]{24}_[a-f0-9]{64}$/),
      expiresAt: z.iso.datetime(),
    })
    .strict(),
  z.object({ status: z.literal("current"), credentialId: z.uuid() }).strict(),
  z.object({ status: z.enum(["unavailable", "revoked", "unregistered"]) }).strict(),
]);
export type WorkloadResponse = z.infer<typeof WorkloadResponseSchema>;
