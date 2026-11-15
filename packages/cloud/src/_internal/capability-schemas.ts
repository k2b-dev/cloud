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

/** Validate before registration even when an independent app uses an unpatched Zod importer. */
const assertUnicodePatterns = (schema: unknown, path = "$"): void => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const node = schema as JsonSchema;
  const check = (pattern: string, at: string) => {
    try {
      new RegExp(pattern, "u");
    } catch {
      throw new Error(`${at} is not a valid Unicode regular expression`);
    }
  };
  if (typeof node.pattern === "string") check(node.pattern, `${path}.pattern`);
  for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
    const entries = node[key];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [name, child] of Object.entries(entries)) {
      const at = `${path}.${key}[${JSON.stringify(name)}]`;
      if (key === "patternProperties") check(name, at);
      assertUnicodePatterns(child, at);
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const entries = node[key];
    if (Array.isArray(entries)) entries.forEach((child, index) => assertUnicodePatterns(child, `${path}.${key}[${index}]`));
  }
  for (const key of [
    "items",
    "additionalItems",
    "contains",
    "propertyNames",
    "additionalProperties",
    "not",
    "if",
    "then",
    "else",
    "unevaluatedProperties",
    "unevaluatedItems",
    "contentSchema",
  ]) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach((item, index) => assertUnicodePatterns(item, `${path}.${key}[${index}]`));
    else assertUnicodePatterns(child, `${path}.${key}`);
  }
};

export const projectSchema = (schema: z.ZodType, label: string, io: "input" | "output"): JsonSchema => {
  try {
    const projected = z.toJSONSchema(schema, { io });
    assertUnicodePatterns(projected);
    z.fromJSONSchema(projected);
    return projected;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not JSON-Schema-round-trippable: ${message}`);
  }
};
