import { z } from "zod";
import { SecretRotationMetadataSchema } from "./app-migration";

export const SecretRotationStatusSchema = z.object({
  checkedAt: z.iso.datetime(),
  current: z.string().nullable(),
  lastRingChange: z.iso.datetime().nullable(),
  ready: z.boolean(),
  registryIssues: z.array(z.object({ key: z.string(), reason: z.string() })),
  apps: z.array(
    z.object({
      appId: z.string(),
      reasons: z.array(z.string()),
      instances: z.array(
        z.object({
          instanceId: z.string(),
          secrets: SecretRotationMetadataSchema.nullable(),
        }),
      ),
    }),
  ),
});
export type SecretRotationStatus = z.infer<typeof SecretRotationStatusSchema>;
