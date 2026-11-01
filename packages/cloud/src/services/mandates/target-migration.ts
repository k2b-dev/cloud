import { z } from "zod";
import { normalizeCapabilityCall } from "../../capabilities/calls";
import { CloudResourceRefSchema, type NormalizedCapabilityCall } from "../../contracts/capabilities";
import snapshot from "./legacy-capability-targets.json";
import { type CapabilityGrant, type MandatePolicyV1, MandatePolicyV1Schema, type TaskGrant } from "./policy";

const coordinate = z.object({ type: z.string(), field: z.string(), encoding: z.literal("root-entry").optional() });
const operationSchema = z.object({
  appId: z.string(),
  capabilityId: z.string(),
  kind: z.enum(["query", "action"]),
  providerName: z.string(),
  target: z.string().optional(),
  legacyTarget: z.string().optional(),
  encoding: z.literal("root-entry").optional(),
  refs: z.record(z.string(), coordinate).optional(),
  fields: z.array(z.string()).optional(),
});
/** Frozen C0b–C0e upgrade data, not a live catalog or an application dependency. */
export const legacyTargetOperations = z.array(operationSchema).parse(snapshot);
export type LegacyTargetOperation = z.output<typeof operationSchema>;

export const legacyTargetOperation = (name: string, kind?: "query" | "action"): LegacyTargetOperation | undefined =>
  legacyTargetOperations.find(
    (operation) =>
      (!kind || operation.kind === kind) && (name === `${operation.appId}.${operation.capabilityId}` || name === operation.providerName),
  );

const fixedId = (value: unknown): string => {
  const id = CloudResourceRefSchema.shape.id.parse(value);
  // Template expressions and wildcards are not a person's confirmation of one resource.
  if (/[{}$*\p{Cc}]/u.test(id) || id.trim() !== id) throw new Error("Target is not a fixed resource ID");
  return id;
};
const resource = (appId: string, type: string, value: unknown, encoding?: "root-entry") => ({
  type: `${appId}.${type}`,
  // Files' existing path-ref contract: the root is baseId followed by an empty path.
  id: encoding ? Buffer.from(`${fixedId(value)}\n`, "utf8").toString("base64url") : fixedId(value),
});

/** Move only explicit literal coordinates; never infer a container from a contained object's ID. */
export const migrateLegacyCapabilityCall = (operation: LegacyTargetOperation, args: unknown): NormalizedCapabilityCall => {
  const input = { ...z.record(z.string(), z.unknown()).parse(args) };
  const target = operation.target
    ? resource(operation.appId, operation.target, input[operation.legacyTarget!], operation.encoding)
    : undefined;
  if (operation.target) delete input[operation.legacyTarget!];
  const refs = Object.fromEntries(
    Object.entries(operation.refs ?? {}).map(([name, ref]) => {
      const value = resource(operation.appId, ref.type, input[ref.field], ref.encoding);
      delete input[ref.field];
      return [name, value];
    }),
  );
  return normalizeCapabilityCall(
    operation.appId,
    {
      localId: operation.capabilityId,
      target: operation.target,
      refs: Object.fromEntries(Object.entries(operation.refs ?? {}).map(([key, ref]) => [key, ref.type])),
    },
    { input, target, refs },
  );
};

const migrateGrant = (grant: TaskGrant): TaskGrant => {
  if (!("appId" in grant)) return grant;
  const operation = legacyTargetOperation(`${grant.appId}.${grant.capabilityId}`, grant.kind);
  if (!operation) throw new Error(`${grant.appId}.${grant.capabilityId}`);
  if (!operation.target) {
    if ((grant.target !== undefined && grant.target !== null) || Object.keys(grant.refs ?? {}).length) throw new Error("Unexpected target");
    return grant;
  }
  if (grant.target !== undefined) {
    normalizeCapabilityCall(
      operation.appId,
      {
        localId: operation.capabilityId,
        target: operation.target,
        refs: Object.fromEntries(Object.entries(operation.refs ?? {}).map(([key, ref]) => [key, ref.type])),
      },
      { input: {}, target: grant.target ?? undefined, refs: grant.refs },
    );
    // An already migrated grant must not retain old coordinates as domain restrictions.
    if (Object.keys(grant.fixedInput).some((key) => !operation.fields?.includes(key))) throw new Error("Ambiguous coordinates");
    return grant;
  }
  if (grant.refs !== undefined) throw new Error("Ambiguous coordinates");
  const call = migrateLegacyCapabilityCall(operation, grant.fixedInput);
  const fixedInput = z.record(z.string(), z.json()).parse(call.input);
  if (Object.keys(fixedInput).some((key) => !operation.fields?.includes(key))) throw new Error("Unknown fixed field");
  return { ...grant, target: call.target, refs: call.refs, fixedInput } satisfies CapabilityGrant;
};

/** A failed conversion returns the original authority intact for inspection; the routine must be paused. */
export const migrateLegacyRoutinePolicy = (
  value: unknown,
): { ok: true; policy: MandatePolicyV1; changed: boolean } | { ok: false; capability: string | null } => {
  const parsed = MandatePolicyV1Schema.safeParse(value);
  if (!parsed.success || parsed.data.grants === undefined) return { ok: false, capability: null };
  const grants: TaskGrant[] = [];
  for (const grant of parsed.data.grants) {
    try {
      grants.push(migrateGrant(grant));
    } catch {
      return { ok: false, capability: "appId" in grant ? `${grant.appId}.${grant.capabilityId}` : grant.kind };
    }
  }
  const policy = { ...parsed.data, grants };
  return { ok: true, policy, changed: JSON.stringify(parsed.data.grants) !== JSON.stringify(grants) };
};

/** Convert a migrated pending snapshot back to today's flat tool arguments only for execution. */
export const migratedCapabilityToolArgs = (call: NormalizedCapabilityCall): Record<string, unknown> => {
  const operation = legacyTargetOperation(call.capability);
  if (!operation) throw new Error("Unknown migrated capability");
  return {
    ...z.record(z.string(), z.unknown()).parse(call.input),
    ...(operation.target && call.target ? { [operation.target]: call.target.id } : {}),
    ...Object.fromEntries(Object.entries(call.refs).map(([field, ref]) => [field, ref.id])),
  };
};
