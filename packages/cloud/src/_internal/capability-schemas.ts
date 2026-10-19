import { createHash } from "node:crypto";
import { z } from "zod";

type JsonSchema = Record<string, unknown>;
export const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
};

export const capabilityHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(stableJsonValue(value)))
    .digest("hex");

export const projectSchema = (schema: z.ZodType, label: string, io: "input" | "output"): JsonSchema => {
  try {
    const projected = z.toJSONSchema(schema, { io });
    z.fromJSONSchema(projected);
    return projected;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not JSON-Schema-round-trippable: ${message}`);
  }
};
