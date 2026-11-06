import { z } from "zod";
import { APP_EVENT_MAX_BYTES } from "../contracts/app-events";
import { capabilityHash, projectSchema } from "./capability-schemas";

/** Closed objects, finite strings and bounded arrays; no recursive refs or open records. */
export const assertBoundedAppEventSchema = (schema: Record<string, unknown>): void => {
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("Event data needs a bounded JSON schema");
    const value = node as Record<string, unknown>;
    if (value.$ref || value.$dynamicRef) throw new Error("Event data cannot contain recursive or referenced schemas");
    if (value.const !== undefined || Array.isArray(value.enum)) return;
    if (Array.isArray(value.anyOf) || Array.isArray(value.oneOf)) {
      for (const branch of (value.anyOf ?? value.oneOf) as unknown[]) visit(branch);
      return;
    }
    if (value.type === "object") {
      if (value.additionalProperties !== false) throw new Error("Event objects must reject unknown properties");
      for (const property of Object.values(value.properties ?? {})) visit(property);
    } else if (value.type === "array") {
      if (!Number.isSafeInteger(value.maxItems) || Number(value.maxItems) < 0) throw new Error("Event arrays need maxItems");
      visit(value.items);
    } else if (value.type === "string") {
      if ((!Number.isSafeInteger(value.maxLength) || Number(value.maxLength) < 0) && value.format !== "uuid") {
        throw new Error("Event strings need maxLength (UUIDs have a fixed bound)");
      }
    } else if (!["number", "integer", "boolean", "null"].includes(String(value.type))) {
      throw new Error("Event data needs a bounded JSON schema");
    }
  };
  if (schema.type !== "object") throw new Error("Event data must be a closed object");
  visit(schema);
  z.fromJSONSchema(structuredClone(schema));
};

export const compileAppEventSchema = (schema: z.ZodType, label: string, mode: "producer" | "reader" = "producer") => {
  const dataSchema = projectSchema(schema, label, mode === "reader" ? "output" : "input");
  const output = projectSchema(schema, label, "output");
  if (capabilityHash(dataSchema) !== capabilityHash(output)) throw new Error(`${label} must preserve its JSON shape`);
  assertBoundedAppEventSchema(dataSchema);
  return { dataSchema, schemaHash: capabilityHash({ dataSchema }) };
};

type JsonValue = z.infer<ReturnType<typeof z.json>>;

const decimalNumber = (value: number): string => {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(text);
  if (!match) return text;
  const [, sign = "", whole = "", fraction = "", exponent = "0"] = match;
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  return (
    sign +
    (point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + "0".repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`)
  );
};

/** PostgreSQL jsonb::text uses spaces after separators and expands numeric exponents. */
export const appEventJsonbBytes = (value: JsonValue): number => {
  const text = (entry: JsonValue): string => {
    if (Array.isArray(entry)) return `[${entry.map(text).join(", ")}]`;
    if (entry !== null && typeof entry === "object")
      return `{${Object.entries(entry)
        .map(([key, child]) => `${JSON.stringify(key)}: ${text(child)}`)
        .join(", ")}}`;
    return typeof entry === "number" ? decimalNumber(entry) : JSON.stringify(entry);
  };
  return new TextEncoder().encode(text(value)).byteLength;
};

export const assertAppEventSize = (value: JsonValue): void => {
  if (appEventJsonbBytes(value) > APP_EVENT_MAX_BYTES)
    throw new Error(`App event exceeds ${APP_EVENT_MAX_BYTES} PostgreSQL jsonb-text bytes`);
};

/** Lower bound for required data; no allocation proportional to maxItems/maxLength. */
export const minimumAppEventDataBytes = (schema: Record<string, unknown>): number => {
  if (schema.const !== undefined) return appEventJsonbBytes(z.json().parse(schema.const));
  if (Array.isArray(schema.enum)) return Math.min(...schema.enum.map((value) => appEventJsonbBytes(z.json().parse(value))));
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives))
    return Math.min(...alternatives.map((value) => minimumAppEventDataBytes(z.record(z.string(), z.unknown()).parse(value))));
  if (schema.type === "string") return 2 + (schema.format === "uuid" ? 36 : Number(schema.minLength ?? 0));
  if (schema.type === "null") return 4;
  if (schema.type === "boolean") return 4;
  if (schema.type === "number" || schema.type === "integer") return 1;
  if (schema.type === "array") {
    const count = Number(schema.minItems ?? 0);
    return 2 + count * minimumAppEventDataBytes(z.record(z.string(), z.unknown()).parse(schema.items)) + Math.max(0, count - 1) * 2;
  }
  const properties = z.record(z.string(), z.unknown()).parse(schema.properties ?? {});
  const keys = z.array(z.string()).parse(schema.required ?? []);
  return (
    2 +
    Math.max(0, keys.length - 1) * 2 +
    keys.reduce(
      (bytes, key) =>
        bytes + appEventJsonbBytes(key) + 2 + minimumAppEventDataBytes(z.record(z.string(), z.unknown()).parse(properties[key])),
      0,
    )
  );
};

export const assertAppEventDeclarationSize = (
  appId: string,
  localId: string,
  definition: { version: number; subject: string; place?: string },
  dataSchema: Record<string, unknown>,
): void => {
  const id = "00000000-0000-4000-8000-000000000001";
  const shell = {
    id,
    type: `${appId}.${localId}`,
    version: definition.version,
    source: appId,
    time: "2000-01-01T00:00:00.000Z",
    subject: { type: `${appId}.${definition.subject}`, id },
    ...(definition.place ? { place: { type: `${appId}.${definition.place}`, id } } : {}),
    data: null,
  };
  if (appEventJsonbBytes(shell) - 4 + minimumAppEventDataBytes(dataSchema) > APP_EVENT_MAX_BYTES)
    throw new Error(`Event ${localId} required envelope cannot fit ${APP_EVENT_MAX_BYTES} bytes`);
};
