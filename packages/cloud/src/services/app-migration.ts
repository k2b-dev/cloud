import { err, fail, ok } from "@k2b/stdlib";
import type { SQL } from "bun";
import { z } from "zod";
import { APP_INSTANCE_PREFIX, appInstanceRegistry, readAppRegistrySnapshot } from "../_internal/registry";
import { env } from "../config/env";
import { AppBootstrapMetadataSchema, type AppMigrationStatus } from "../contracts/app-migration";
import type { User } from "../contracts/shared";
import { sql } from "../runtime/clients";
import { isDevelopmentPublicKey } from "../runtime/development-keys";

export type MigrationInstance = { appId: string; instanceId: string; hostname: string; bootstrap?: unknown };
/** A missing process or an old producer cannot prove completion. Check every replica. */
export const evaluateAppMigration = (input: {
  activeKeys: { appId: string; keyId: string }[];
  registeredApps: string[];
  instances: MigrationInstance[];
  expect: string[];
  allowEnv: string[];
  registryIssues?: { key: string; reason: string }[];
}): AppMigrationStatus => {
  const keyedApps = [...new Set(input.activeKeys.map((key) => key.appId))];
  const ids = new Set([...keyedApps, ...input.registeredApps, ...input.instances.map((i) => i.appId), ...input.expect]);
  ids.delete("core");
  ids.delete("gateway");
  const apps: AppMigrationStatus["apps"] = [...ids].sort().map((appId) => {
    const allowedEnv = input.allowEnv.includes(appId);
    const instances: AppMigrationStatus["apps"][number]["instances"] = input.instances
      .filter((i) => i.appId === appId)
      .map((i) => {
        const parsed = AppBootstrapMetadataSchema.safeParse(i.bootstrap);
        const bootstrap = parsed.success ? parsed.data : null;
        const status =
          !bootstrap || (bootstrap.mode === "core" && !input.activeKeys.some((key) => key.appId === appId && key.keyId === bootstrap.keyId))
            ? "unknown"
            : bootstrap.mode === "core" &&
                Object.values(bootstrap.sources).every((group) => Object.values(group).every((s) => s === "core"))
              ? "core"
              : "env";
        return {
          instanceId: i.instanceId,
          hostname: i.hostname,
          bootstrap,
          status,
          allowed: status === "core" || (status === "env" && allowedEnv),
        };
      });
    const modes = new Set(instances.map((i) => i.status));
    const status = !instances.length
      ? input.registeredApps.includes(appId)
        ? "unknown"
        : "stopped"
      : modes.has("unknown")
        ? "unknown"
        : modes.size > 1
          ? "mixed"
          : modes.has("env")
            ? "env"
            : "core";
    return {
      appId,
      expectedBy: [
        ...(keyedApps.includes(appId) ? ["keys" as const] : []),
        ...(input.registeredApps.includes(appId) ? ["registry" as const] : []),
        ...(input.expect.includes(appId) ? ["expect" as const] : []),
      ],
      status,
      allowedEnv,
      needsAttention: !instances.length || instances.some((i) => !i.allowed),
      instances,
    };
  });
  const registryIssues = input.registryIssues ?? [];
  return { needsAttention: registryIssues.length > 0 || apps.length === 0 || apps.some((a) => a.needsAttention), registryIssues, apps };
};

/** Active, usable credentials define expected apps; historical retirement does not. */
export const listActiveMigrationKeys = async (db: SQL = sql) => {
  const keys = await db<
    { appId: string; keyId: string; publicKey: string }[]
  >`SELECT sa.app_id AS "appId", c.id AS "keyId", c.public_key AS "publicKey" FROM auth.service_account_credentials c
      JOIN auth.service_accounts sa ON sa.id = c.service_account_id
      WHERE c.kind = 'app_key' AND c.status = 'active' AND (c.expires_at IS NULL OR c.expires_at > now())
        AND sa.status = 'active' AND sa.kind = 'resource_bound' AND sa.resource_type = 'cloud.app' AND sa.resource_id = sa.app_id`;
  return keys.filter((key) => env.NODE_ENV === "development" || !isDevelopmentPublicKey(key.publicKey));
};

export const readAppMigrationStatus = async (input: { actor: Pick<User, "roles">; expect: string[]; allowEnv: string[] }) => {
  if (!input.actor.roles.includes("admin")) return fail(err.forbidden("Administrator access required"));
  const [keys, registry, instances] = await Promise.all([
    listActiveMigrationKeys(),
    readAppRegistrySnapshot(),
    appInstanceRegistry().snapshot({ prefix: APP_INSTANCE_PREFIX }),
  ]);
  const validInstances: MigrationInstance[] = [];
  const registryIssues = [...registry.issues];
  const instanceSchema = z.object({
    appId: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    instanceId: z.string().min(1),
    hostname: z.string(),
    bootstrap: z.unknown().optional(),
  });
  for (const entry of instances.entries) {
    const parsed = instanceSchema.safeParse(entry.value);
    if (parsed.success) validInstances.push(parsed.data);
    else registryIssues.push({ key: entry.key, version: entry.revision, reason: "Invalid application instance record" });
  }
  return ok(
    evaluateAppMigration({
      ...input,
      activeKeys: keys,
      registeredApps: registry.apps.map((a) => a.id),
      instances: validInstances,
      registryIssues,
    }),
  );
};
