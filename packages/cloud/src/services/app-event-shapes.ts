import { createHash } from "node:crypto";
import { z } from "zod";

type Schema = Record<string, unknown>;
const object = (value: unknown): Schema | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Schema) : null;
const valid = (schema: Schema, value: unknown) => z.fromJSONSchema(schema).safeParse(value).success;
const UUID = "00000000-0000-4000-8000-000000000001";

export type RecordedAppEventShape =
  | { keys: Record<string, RecordedAppEventShape> }
  | { length: number; items: RecordedAppEventShape[] }
  | null;

/** Retains key presence and bucketed array structure, without scalar values. */
export function recordedAppEventShape(data: unknown): RecordedAppEventShape {
  if (Array.isArray(data)) {
    const length = data.length === 0 ? 0 : data.length === 1 ? 1 : data.length <= 4 ? 2 : data.length <= 16 ? 5 : 17;
    const items = [
      ...new Map(
        data.map((item) => {
          const shape = recordedAppEventShape(item);
          return [JSON.stringify(shape), shape] as const;
        }),
      ).entries(),
    ]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, shape]) => shape);
    return { length, items };
  }
  const properties = object(data);
  return properties
    ? {
        keys: Object.fromEntries(
          Object.keys(properties)
            .sort()
            .map((key) => [key, recordedAppEventShape(properties[key])]),
        ),
      }
    : null;
}

export const appEventShapeId = (type: string, version: number, shape: RecordedAppEventShape) => {
  const hash = createHash("sha256")
    .update(JSON.stringify([type, version, shape]))
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

/** Synthesizes values from the declaration, using only recorded structure when supplied. */
export const appEventShape = (schema: Schema, depth = 0, shape?: RecordedAppEventShape): unknown => {
  if (depth > 16) throw new Error("shape_unavailable");
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[key]))
      for (const branch of schema[key]) {
        const sub = object(branch);
        if (!sub) continue;
        try {
          const value = appEventShape(sub, depth + 1, shape);
          if (valid(schema, value)) return value;
        } catch {}
      }
  }
  if (Array.isArray(schema.type))
    for (const type of schema.type) {
      try {
        const value = appEventShape({ ...schema, type }, depth + 1, shape);
        if (valid(schema, value)) return value;
      } catch {}
    }
  if (schema.type === "null") return null;
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") {
    const step = typeof schema.multipleOf === "number" ? schema.multipleOf : 1;
    let n =
      typeof schema.minimum === "number"
        ? schema.minimum
        : typeof schema.exclusiveMinimum === "number"
          ? schema.exclusiveMinimum + step
          : 0;
    if (typeof schema.maximum === "number") n = Math.min(n, schema.maximum);
    if (typeof schema.exclusiveMaximum === "number") n = Math.min(n, schema.exclusiveMaximum - step);
    n = Math.ceil(n / step) * step;
    if (valid(schema, n)) return n;
  }
  if (schema.type === "string") {
    const min = typeof schema.minLength === "number" ? schema.minLength : 0;
    const max = typeof schema.maxLength === "number" ? schema.maxLength : 256;
    if (min > 4096) throw new Error("shape_unavailable");
    const exact = typeof schema.pattern === "string" ? schema.pattern.match(/^\^([a-zA-Z0-9_.@:/ -]+)\$$/)?.[1] : undefined;
    const candidates = [
      exact,
      UUID,
      "2000-01-01T00:00:00.000Z",
      "2000-01-01",
      "00:00:00",
      "https://example.invalid/",
      "fixture@example.invalid",
      "127.0.0.1",
      "fixture",
      "local",
      "ipa",
      "a".repeat(Math.max(1, min)),
      "0".repeat(Math.max(1, min)),
      "",
    ];
    for (const value of candidates) if (typeof value === "string" && value.length <= max && valid(schema, value)) return value;
  }
  if (schema.type === "array") {
    const minimum = typeof schema.minItems === "number" ? schema.minItems : 0;
    const count = Math.max(minimum, shape && "length" in shape ? shape.length : 0);
    if (count > 100) throw new Error("shape_unavailable");
    const item = object(schema.items);
    const value = Array.from({ length: count }, (_, index) =>
      appEventShape(
        object(Array.isArray(schema.prefixItems) ? schema.prefixItems[index] : null) ?? item ?? { type: "null" },
        depth + 1,
        shape && "items" in shape ? shape.items[index % shape.items.length] : undefined,
      ),
    );
    if (valid(schema, value)) return value;
  }
  if (schema.type === "object") {
    const properties = object(schema.properties) ?? {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const value: Record<string, unknown> = {};
    const keys = shape && "keys" in shape ? [...new Set([...required, ...Object.keys(shape.keys)])] : required;
    for (const key of keys) {
      if (typeof key !== "string") throw new Error("shape_unavailable");
      const property = object(properties[key]);
      if (!property) throw new Error("shape_unavailable");
      value[key] = appEventShape(property, depth + 1, shape && "keys" in shape ? shape.keys[key] : undefined);
    }
    if (valid(schema, value)) return value;
  }
  throw new Error("shape_unavailable");
};
