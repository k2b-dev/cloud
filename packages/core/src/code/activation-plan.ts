import {
  type CapabilityManifest,
  CodeAccessOperationsSchema,
  type CodeAccessTarget,
  type CodeCheckedVersionManifest,
  cloudResourceRefAppId,
} from "@k2b/cloud/contracts";
import {
  type CapabilityGrant,
  MANDATE_POLICY_MAX_IDENTIFIERS,
  type MandatePolicyV1,
  parseMandatePolicy,
} from "@k2b/cloud/services/mandates";
import { z } from "zod";
import { CodeDataError } from "./access";
import type { Code } from "./contracts";

export const activationTargetSchema = z
  .object({
    target: z.object({ type: z.string(), id: z.string() }).strict(),
    operations: CodeAccessOperationsSchema,
    grantId: z.uuid(),
    reused: z.boolean(),
    owner: z.boolean(),
    managerUserIds: z.array(z.uuid()).optional(),
  })
  .strict();
/** Persisted before issuing any proof. Reused grants are never rolled back by this process. */
export type CodeActivationTarget = z.infer<typeof activationTargetSchema>;
export const targetKey = (target: CodeAccessTarget): string => JSON.stringify([target.type, target.id]);
export const targetApp = (target: CodeAccessTarget): string => (target.type === "app" ? target.id : cloudResourceRefAppId(target));
export const ownerTarget = (code: Code): CodeAccessTarget | null =>
  code.owner.kind === "resource" ? code.owner.ref : code.owner.kind === "app" ? { type: "app", id: code.owner.appId } : null;

/** One entry per operation at a target; queries retain operation-only mandate grants. Flat checker rows authorize operation/target sets; refs use their type-matching combinations, bounded by the mandate budget. */
export function buildCodeActivationPlan(
  code: Code,
  manifest: CodeCheckedVersionManifest,
  catalogs: ReadonlyMap<string, CapabilityManifest>,
): {
  targets: Array<{ target: CodeAccessTarget; operations: string[] }>;
  policy: MandatePolicyV1;
} {
  const grouped = new Map<string, { target: CodeAccessTarget; operations: Set<string> }>();
  const grants: CapabilityGrant[] = [];
  const apps = new Set<string>(),
    operations = new Set<string>();
  const unique = new Set(manifest.permissions.map((p) => p.operation));
  for (const operation of unique) {
    const [appId, ...parts] = operation.split(".");
    const localId = parts.join(".");
    const catalog = catalogs.get(appId!);
    const query = catalog?.queries.find((q) => q.localId === localId);
    const action = catalog?.actions.find((a) => a.localId === localId);
    if ((!query && !action) || query?.stream || action?.stream || action?.code === false || localId.startsWith("code.access."))
      throw new CodeDataError("BAD_INPUT", "An operation is unavailable to this Code version.");
    apps.add(appId!);
    operations.add(`${query ? "capability.query" : "capability.action.run"}:${localId}`);
    if (action) operations.add(`capability.action.review:${localId}`);
    const permissions = manifest.permissions.filter((p) => p.operation === operation);
    for (const permission of permissions) {
      if (code.owner.kind === "person") continue;
      if (permission.target?.id === null) throw new CodeDataError("BAD_INPUT", "Resource Code requires literal targets.");
      const target = permission.target ? { type: permission.target.type, id: permission.target.id! } : { type: "app", id: appId! };
      const key = targetKey(target);
      const group = grouped.get(key) ?? { target, operations: new Set<string>() };
      group.operations.add(operation);
      grouped.set(key, group);
    }
    if (query || code.owner.kind === "person") {
      grants.push({ appId: appId!, capabilityId: localId, kind: query ? "query" : "action", fixedInput: {} });
      continue;
    }
    const choices = (type: string) => [
      ...new Map(
        permissions
          .filter((p) => p.target?.type === `${appId}.${type}` && p.target.id !== null)
          .map((p) => [p.target!.id!, { type: p.target!.type, id: p.target!.id! }]),
      ).values(),
    ];
    const primary = action?.target ? choices(action.target) : [null];
    if (!primary.length) throw new CodeDataError("BAD_INPUT", "An action's exact primary target is missing.");
    let refs: Array<Record<string, { type: string; id: string }>> = [{}];
    for (const [field, type] of Object.entries(action?.refs ?? {})) {
      const candidates = choices(type);
      if (!candidates.length) throw new CodeDataError("BAD_INPUT", "An action's exact additional target is missing.");
      refs = refs.flatMap((prior) => candidates.map((target) => ({ ...prior, [field]: target })));
      if (refs.length > MANDATE_POLICY_MAX_IDENTIFIERS / 2)
        throw new CodeDataError("BAD_INPUT", "Version exceeds the mandate grant budget.");
    }
    for (const target of primary)
      for (const ref of refs) {
        grants.push({ appId: appId!, capabilityId: localId, kind: "action", target, refs: ref, fixedInput: {} });
        if (grants.length > MANDATE_POLICY_MAX_IDENTIFIERS / 2)
          throw new CodeDataError("BAD_INPUT", "Version exceeds the mandate grant budget.");
      }
  }
  const policy = parseMandatePolicy({
    version: 1,
    apps: [...apps].sort(),
    operations: [...operations].sort(),
    actions: grants.some((g) => g.kind === "action") ? "preapproved" : "deny",
    ...(code.owner.kind === "person" ? {} : { grants }),
  });
  return {
    targets: [...grouped.values()].map((g) => ({
      target: g.target,
      operations: CodeAccessOperationsSchema.parse([...g.operations].sort()),
    })),
    policy,
  };
}
