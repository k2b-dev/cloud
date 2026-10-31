import { z } from "zod";

export const APP_MIGRATION_RECEIPT_PATH = "/api/_internal/identity/v1/migration-probe";
export const APP_MIGRATION_TRIGGER_PATH = "/api/_internal/app-migration/v1";

const source = z.enum(["env", "core"]);
export const AppBootstrapMetadataSchema = z.object({
  keyId: z.uuid().optional(),
  mode: z.enum(["core", "env"]),
  sources: z.object({
    database: z.object({ url: source }),
    valkey: z.object({ url: source }),
    nats: z.object({
      servers: source,
      namespace: source,
      replicas: source,
      ignoreClusterUpdates: source,
      creds: source.optional(),
      ca: source.optional(),
    }),
    appSecret: z.object({ current: source, previous: source.optional(), next: source.optional() }),
  }),
  keyFormat: z.literal("cloud-app-key-v1"),
  protocol: z.literal(1),
});
const instance = z.object({
  instanceId: z.string(),
  hostname: z.string(),
  bootstrap: AppBootstrapMetadataSchema.nullable(),
  status: z.enum(["core", "env", "unknown"]),
  allowed: z.boolean(),
});
export const AppMigrationObservationSchema = z.object({
  startedAt: z.iso.datetime().nullable(),
  lastLegacyUseAt: z.iso.datetime().nullable(),
  observedAt: z.iso.datetime(),
  windowSeconds: z.number().int().positive().nullable(),
  complete: z.boolean(),
});
export const AppMigrationProbeSchema = z.object({ keyId: z.uuid(), broker: z.boolean(), oauth: z.boolean().nullable() });
export const AppMigrationStatusSchema = z.object({
  needsAttention: z.boolean(),
  observation: AppMigrationObservationSchema,
  registryIssues: z.array(z.object({ key: z.string(), reason: z.string() })),
  apps: z.array(
    z.object({
      appId: z.string(),
      expectedBy: z.array(z.enum(["keys", "registry", "expect"])),
      status: z.enum(["core", "env", "mixed", "unknown", "stopped"]),
      allowedEnv: z.boolean(),
      needsAttention: z.boolean(),
      attentionReasons: z.array(z.string()),
      lastRejectedStart: z
        .object({
          at: z.iso.datetime(),
          reason: z.enum(["revoked", "expired", "disabled", "connections_not_permitted"]),
          keyId: z.uuid().nullable(),
        })
        .nullable(),
      probes: z.array(AppMigrationProbeSchema),
      instances: z.array(instance),
    }),
  ),
});
export type AppMigrationStatus = z.infer<typeof AppMigrationStatusSchema>;
