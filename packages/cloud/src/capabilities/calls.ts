import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type CapabilityActionManifest,
  type CapabilityInvocationBody,
  CapabilityInvocationBodySchema,
  type CapabilityQueryManifest,
  type CapabilityTargetDefinition,
  CLOUD_RESOURCE_ID_MAX_LENGTH,
  CloudResourceRefSchema,
  type NormalizedCapabilityCall,
  NormalizedCapabilityCallSchema,
} from "../contracts/capabilities";

/** Stable JSON for JSON transport values; object order never changes a digest. */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
};

/** Deterministic SHA-256 of a JSON value, also used for legacy input-only hashes. */
export const capabilityValueDigest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

/**
 * SHA-256 of the complete normalized call, including qualified capability, target and refs.
 * Excludes transport names, locale, request ID and idempotency key. Review, approval and
 * retry consumers must hash this same value, after validating the domain input.
 */
export const capabilityCallDigest = (call: NormalizedCapabilityCall): string => capabilityValueDigest(call);

/** Checks transport-field collisions, including reserved Action metadata, before offering a tool. */
export const capabilityToolInputSchema = (operation: CapabilityQueryManifest | CapabilityActionManifest): Record<string, unknown> => {
  const schema = structuredClone(operation.inputSchema);
  const properties = z.record(z.string(), z.unknown()).parse(schema.properties ?? {});
  const required = new Set(z.array(z.string()).parse(schema.required ?? []));
  const add = (field: string, type: string) => {
    if (
      ["__proto__", "constructor", "prototype"].includes(field) ||
      Object.hasOwn(properties, field) ||
      ("idempotency" in operation && ["idempotencyKey", "approvalReason"].includes(field))
    )
      throw new Error(`Capability ${operation.localId}: target field "${field}" collides with an input or transport field`);
    properties[field] = { type: "string", minLength: 1, maxLength: CLOUD_RESOURCE_ID_MAX_LENGTH, description: `Resource ID of ${type}.` };
    required.add(field);
  };
  if (operation.target) add(operation.target, operation.target);
  for (const [field, type] of Object.entries(operation.refs ?? {})) add(field, type);
  return { ...schema, properties, ...(required.size ? { required: [...required] } : {}) };
};

/** Validates resource coordinates against the fixed types in one live operation contract. */
export const normalizeCapabilityCall = (
  appId: string,
  operation: CapabilityTargetDefinition & { localId: string },
  body: unknown,
): NormalizedCapabilityCall => {
  const parsed = CapabilityInvocationBodySchema.parse(body);
  const shape = Object.fromEntries(
    Object.entries(operation.refs ?? {}).map(([field, type]) => [
      field,
      CloudResourceRefSchema.extend({ type: z.literal(`${appId}.${type}`) }).strict(),
    ]),
  );
  const { target, refs } = z
    .object({
      target: operation.target
        ? CloudResourceRefSchema.extend({ type: z.literal(`${appId}.${operation.target}`) }).strict()
        : z.undefined(),
      refs: z.object(shape).strict(),
    })
    .parse({ target: parsed.target, refs: parsed.refs ?? {} });
  return NormalizedCapabilityCallSchema.parse({
    capability: `${appId}.${operation.localId}`,
    target: target ?? null,
    refs,
    input: parsed.input,
  });
};

/** Converts flat chat/MCP arguments into the same call used by HTTP and the SDK. */
export const capabilityCallFromTool = (
  appId: string,
  operation: CapabilityQueryManifest | CapabilityActionManifest,
  args: unknown,
): NormalizedCapabilityCall => {
  capabilityToolInputSchema(operation);
  const input = z.record(z.string(), z.unknown()).parse(args);
  const resourceId = (field: string, type: string): string => {
    const id = CloudResourceRefSchema.shape.id.safeParse(input[field]);
    if (!id.success) throw new Error(`Invalid target field "${field}" (Resource ID of ${type})`);
    return id.data;
  };
  const refs = Object.fromEntries(
    Object.entries(operation.refs ?? {}).map(([field, type]) => {
      const id = resourceId(field, type);
      delete input[field];
      return [field, { type: `${appId}.${type}`, id }];
    }),
  );
  let target: NormalizedCapabilityCall["target"] = null;
  if (operation.target) {
    target = { type: `${appId}.${operation.target}`, id: resourceId(operation.target, operation.target) };
    delete input[operation.target];
  }
  return normalizeCapabilityCall(appId, operation, { input, ...(target ? { target } : {}), refs });
};

/** Omits empty coordinates so legacy app-wide transports retain their exact wire shape. */
export const capabilityInvocationBody = (call: NormalizedCapabilityCall): CapabilityInvocationBody => ({
  input: call.input,
  ...(call.target ? { target: call.target } : {}),
  ...(Object.keys(call.refs).length ? { refs: call.refs } : {}),
});
