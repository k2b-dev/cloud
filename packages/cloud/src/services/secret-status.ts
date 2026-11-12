import { err, fail, ok } from "@k2b/stdlib";
import { z } from "zod";
import { APP_INSTANCE_PREFIX, appInstanceRegistry, readAppRegistrySnapshot } from "../_internal/registry";
import { SecretRotationMetadataSchema } from "../contracts/app-migration";
import type { SecretRotationStatus } from "../contracts/secret-status";
import type { User } from "../contracts/shared";
import { listGatewayRouteSnapshots } from "./gateway";

export type SecretRotationInstance = { appId: string; instanceId: string; secrets?: unknown };

/** Registry absence and old producers are unknown. Core and Gateway are always expected. */
export const evaluateSecretRotation = (input: {
  registeredApps: string[];
  instances: SecretRotationInstance[];
  expect: string[];
  registryIssues?: { key: string; reason: string }[];
  now: Date;
}): SecretRotationStatus => {
  const instances = input.instances.map((instance) => {
    const parsed = SecretRotationMetadataSchema.safeParse(instance.secrets);
    return { ...instance, secrets: parsed.success ? parsed.data : null };
  });
  const currents = new Set(instances.flatMap((instance) => (instance.secrets ? [instance.secrets.current] : [])));
  const current = currents.size === 1 ? [...currents][0]! : null;
  const changedAt = instances.flatMap((instance) => (instance.secrets ? [Date.parse(instance.secrets.changedAt)] : []));
  const latestChange = changedAt.length ? Math.max(...changedAt) : null;
  const ids = new Set(["core", "gateway", ...input.registeredApps, ...input.expect, ...instances.map((instance) => instance.appId)]);
  const apps = [...ids].sort().map((appId) => {
    const live = instances.filter((instance) => instance.appId === appId);
    const reasons = new Set<string>();
    const declarations = new Set(
      live.flatMap((instance) =>
        instance.secrets?.owners ? [JSON.stringify(instance.secrets.owners.map((owner) => owner.id).sort())] : [],
      ),
    );
    if (declarations.size > 1) reasons.add("owner_declaration_drift");
    if (!live.length) reasons.add("no_live_instance");
    for (const instance of live) {
      const metadata = instance.secrets;
      if (!metadata) {
        reasons.add("unknown_ring");
        continue;
      }
      if (current === null) reasons.add("different_current_roots");
      if (metadata.owners === undefined) {
        reasons.add("missing_owner_declaration");
        continue;
      }
      if (new Set(metadata.owners.map((owner) => owner.id)).size !== metadata.owners.length) reasons.add("duplicate_owner_declaration");
      for (const owner of metadata.owners) {
        if (
          owner.checkedAt === null ||
          latestChange === null ||
          Date.parse(owner.checkedAt) <= latestChange ||
          Date.parse(owner.checkedAt) > input.now.getTime()
        )
          reasons.add(`stale_owner_check:${owner.id}`);
        if (owner.previousOnly > 0) reasons.add(`previous_root_rows:${owner.id}`);
        if (owner.unreadable > 0) reasons.add(`unreadable_rows:${owner.id}`);
        if (owner.previousOnly > owner.rows || owner.unreadable > owner.rows) reasons.add(`invalid_owner_counts:${owner.id}`);
      }
    }
    return {
      appId,
      reasons: [...reasons],
      instances: live.map(({ instanceId, secrets }) => ({ instanceId, secrets })),
    };
  });
  const registryIssues = input.registryIssues ?? [];
  return {
    checkedAt: input.now.toISOString(),
    current,
    lastRingChange: latestChange === null ? null : new Date(latestChange).toISOString(),
    ready: current !== null && registryIssues.length === 0 && apps.every((app) => app.reasons.length === 0),
    registryIssues,
    apps,
  };
};

export const readSecretRotationStatus = async (input: { actor: Pick<User, "roles">; expect: string[] }) => {
  if (!input.actor.roles.includes("admin")) return fail(err.forbidden("Administrator access required"));
  const [registry, snapshot, gateways] = await Promise.all([
    readAppRegistrySnapshot(),
    appInstanceRegistry().snapshot({ prefix: APP_INSTANCE_PREFIX }),
    listGatewayRouteSnapshots(),
  ]);
  const instanceSchema = z.object({ appId: z.string().min(1), instanceId: z.string().min(1), secrets: z.unknown().optional() });
  const instances: SecretRotationInstance[] = [];
  const registryIssues: { key: string; reason: string }[] = [...registry.issues];
  for (const entry of snapshot.entries) {
    const parsed = instanceSchema.safeParse(entry.value);
    if (parsed.success) instances.push(parsed.data);
    else registryIssues.push({ key: entry.key, reason: "Invalid application instance record" });
  }
  for (const gateway of gateways) instances.push({ appId: "gateway", instanceId: gateway.instanceId, secrets: gateway.secrets });
  return ok(
    evaluateSecretRotation({
      registeredApps: registry.apps.map((app) => app.id),
      instances,
      expect: input.expect,
      registryIssues,
      now: new Date(),
    }),
  );
};
