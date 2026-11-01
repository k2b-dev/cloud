import { err, fail, ok } from "@k2b/stdlib";
import type { SQL } from "bun";
import { z } from "zod";
import { APP_INSTANCE_PREFIX, appInstanceRegistry, readAppRegistrySnapshot } from "../_internal/registry";
import { startBounded, waitWithin } from "../api/fanout";
import { APP_MIGRATION_TRIGGER_PATH, AppBootstrapMetadataSchema, type AppMigrationStatus } from "../contracts/app-migration";
import type { User } from "../contracts/shared";
import { sql } from "../runtime/clients";
import { REQUEST_IDLE_TIMEOUT_SECONDS } from "../server/request-timeout";
import type { LastRejectedStart } from "./app-keys";
import { coreEvidenceIssues, readAppMigrationObservation } from "./app-migration-evidence";
import { signMigrationProbe } from "./identity/invocation-token";

export type MigrationInstance = { appId: string; instanceId: string; hostname: string; bootstrap?: unknown; legacyEvidence?: unknown };
/** A missing process or an old producer cannot prove completion. Check every replica. */
export const evaluateAppMigration = (input: {
  activeKeys: { appId: string; keyId: string }[];
  registeredApps: string[];
  instances: MigrationInstance[];
  expect: string[];
  allowEnv: string[];
  probes?: (AppMigrationStatus["apps"][number]["probes"][number] & { appId: string })[];
  observation?: AppMigrationStatus["observation"];
  rejections?: { appId: string; lastRejectedStart: LastRejectedStart }[];
  registryIssues?: { key: string; reason: string }[];
}): AppMigrationStatus => {
  const observation = input.observation ?? {
    startedAt: null,
    lastLegacyUseAt: null,
    observedAt: new Date(0).toISOString(),
    windowSeconds: null,
    complete: false,
  };
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
    const liveKeyIds = [...new Set(instances.map((instance) => instance.bootstrap?.keyId).filter((id): id is string => !!id))];
    const probes = liveKeyIds.map((keyId) => {
      const probe = input.probes?.find((probe) => probe.appId === appId && probe.keyId === keyId);
      return {
        keyId,
        broker: probe?.broker ?? false,
        oauth: probe?.oauth ?? (probe ? null : false),
        ...(probe?.reason ? { reason: probe.reason } : {}),
      };
    });
    const lastRejectedStart = input.rejections?.find((rejection) => rejection.appId === appId)?.lastRejectedStart ?? null;
    const attentionReasons = [
      ...(!instances.length ? ["no_live_instance"] : []),
      ...(instances.some((instance) => !instance.allowed) ? ["bootstrap_incomplete"] : []),
      ...(!liveKeyIds.length ||
      instances.some((instance) => !instance.bootstrap?.keyId) ||
      probes.some((probe) => !probe.broker || probe.oauth === false)
        ? ["signed_probe_incomplete"]
        : []),
      ...probes.flatMap((probe) => (probe.reason ? [`${probe.reason}:${probe.keyId}`] : [])),
      ...(!observation.complete ? ["legacy_observation_incomplete"] : []),
      ...(lastRejectedStart ? ["last_rejected_start"] : []),
    ];
    return {
      appId,
      expectedBy: [
        ...(keyedApps.includes(appId) ? ["keys" as const] : []),
        ...(input.registeredApps.includes(appId) ? ["registry" as const] : []),
        ...(input.expect.includes(appId) ? ["expect" as const] : []),
      ],
      status,
      allowedEnv,
      needsAttention: attentionReasons.length > 0,
      attentionReasons,
      lastRejectedStart,
      probes,
      instances,
    };
  });
  const registryIssues = [...(input.registryIssues ?? []), ...coreEvidenceIssues(input.instances)];
  return {
    observation,
    needsAttention: !observation.complete || registryIssues.length > 0 || apps.length === 0 || apps.some((a) => a.needsAttention),
    registryIssues,
    apps,
  };
};

/** Active, usable credentials define expected apps; historical retirement does not. */
export const listActiveMigrationKeys = async (db: SQL = sql) => {
  const keys = await db<
    { appId: string; keyId: string; publicKey: string; oauthIssueAllowed: boolean }[]
  >`SELECT sa.app_id AS "appId", c.id AS "keyId", c.public_key AS "publicKey", c.oauth_issue_allowed AS "oauthIssueAllowed" FROM auth.service_account_credentials c
      JOIN auth.service_accounts sa ON sa.id = c.service_account_id
      WHERE c.kind = 'app_key' AND c.status = 'active' AND (c.expires_at IS NULL OR c.expires_at > now())
        AND sa.status = 'active' AND sa.kind = 'resource_bound' AND sa.resource_type = 'cloud.app' AND sa.resource_id = sa.app_id`;
  return keys;
};

export const readAppMigrationStatus = async (input: {
  actor: Pick<User, "roles">;
  expect: string[];
  allowEnv: string[];
  windowSeconds?: number;
  signal?: AbortSignal;
}) => {
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
    legacyEvidence: z.unknown().optional(),
  });
  for (const entry of instances.entries) {
    const parsed = instanceSchema.safeParse(entry.value);
    if (parsed.success) validInstances.push(parsed.data);
    else registryIssues.push({ key: entry.key, version: entry.revision, reason: "Invalid application instance record" });
  }
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout((REQUEST_IDLE_TIMEOUT_SECONDS - 4) * 1000)]);
  const liveKeys = keys.filter((key) =>
    validInstances.some((instance) => {
      const metadata = AppBootstrapMetadataSchema.safeParse(instance.bootstrap);
      return instance.appId === key.appId && metadata.success && metadata.data.keyId === key.keyId;
    }),
  );
  // Four probes share a six-second budget, leaving time to return JSON before the idle timeout.
  const results = await Promise.all(
    startBounded(
      liveKeys,
      4,
      async (key) => {
        const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(1_500)]);
        return waitWithin(
          (async () => {
            const nonce = crypto.randomUUID();
            const app = registry.apps.find((app) => app.id === key.appId);
            if (!app) throw new Error("Application has no registered endpoint");
            const token = await signMigrationProbe({ appId: key.appId, keyId: key.keyId, oauth: key.oauthIssueAllowed, nonce });
            probeSignal.throwIfAborted();
            const response = await fetch(new URL(`${APP_MIGRATION_TRIGGER_PATH}/probe`, app.baseUrl), {
              method: "POST",
              headers: { authorization: `Bearer ${token}` },
              signal: probeSignal,
              redirect: "error",
            });
            await response.body?.cancel();
            if (response.status !== 204) throw new Error("Signed migration probe failed");
            const receipts = await sql<{ scope: string }[]>`SELECT scope FROM auth.app_migration_probes
      WHERE key_id = ${key.keyId}::uuid AND nonce = ${nonce}::uuid`;
            const broker = receipts.some((receipt) => receipt.scope === "identity:invoke");
            const oauth = key.oauthIssueAllowed ? receipts.some((receipt) => receipt.scope === "oauth:issue") : null;
            return {
              appId: key.appId,
              keyId: key.keyId,
              broker,
              oauth,
              ...(!broker || oauth === false ? { reason: "probe_failed" as const } : {}),
            };
          })(),
          probeSignal,
        );
      },
      signal,
    ),
  );
  const rejections = await sql<{ app_id: string; rejected_at: Date; reason: LastRejectedStart["reason"]; key_id: string | null }[]>`
    SELECT app_id, rejected_at, reason, key_id FROM auth.app_start_rejections`;
  return ok(
    evaluateAppMigration({
      ...input,
      activeKeys: keys,
      registeredApps: registry.apps.map((a) => a.id),
      instances: validInstances,
      registryIssues,
      observation: await readAppMigrationObservation(input.windowSeconds),
      probes: liveKeys.map((key, index) => {
        const result = results[index];
        return result?.status === "fulfilled"
          ? result.value
          : {
              appId: key.appId,
              keyId: key.keyId,
              broker: false,
              oauth: key.oauthIssueAllowed ? false : null,
              reason:
                result?.status === "rejected" && result.reason instanceof Error && result.reason.name === "TimeoutError"
                  ? ("probe_timeout" as const)
                  : ("probe_failed" as const),
            };
      }),
      rejections: rejections.map((row) => ({
        appId: row.app_id,
        lastRejectedStart: { at: row.rejected_at.toISOString(), reason: row.reason, keyId: row.key_id },
      })),
    }),
  );
};
