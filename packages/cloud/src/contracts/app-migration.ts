import { z } from "zod";

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
export const AppMigrationStatusSchema = z.object({
  needsAttention: z.boolean(),
  registryIssues: z.array(z.object({ key: z.string(), reason: z.string() })),
  apps: z.array(
    z.object({
      appId: z.string(),
      expectedBy: z.array(z.enum(["keys", "registry", "expect"])),
      status: z.enum(["core", "env", "mixed", "unknown", "stopped"]),
      allowedEnv: z.boolean(),
      needsAttention: z.boolean(),
      instances: z.array(instance),
    }),
  ),
});
export type AppMigrationStatus = z.infer<typeof AppMigrationStatusSchema>;
