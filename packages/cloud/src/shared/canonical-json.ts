export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const compareJsonKeys = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const normalizeUnknown = (value: unknown, path: string): JsonValue => {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => normalizeUnknown(item, `${path}[${index}]`));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain JSON object`);
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareJsonKeys(left, right))
      .map(([key, item]) => [key, normalizeUnknown(item, `${path}.${key}`)] as const);
    return Object.fromEntries(entries) as Record<string, JsonValue>;
  }
  throw new TypeError(`${path} must contain only JSON values`);
};

export const normalizeJson = <T extends JsonValue>(value: T): T => normalizeUnknown(value, "value") as T;

export const canonicalJson = (value: unknown): string => JSON.stringify(normalizeUnknown(value, "value"));
