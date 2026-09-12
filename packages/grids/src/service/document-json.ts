import { createHash } from "node:crypto";
import { err } from "@k2b/stdlib";
import { documentServiceText } from "./document-messages";

export const MAX_DOCUMENT_PROFILE_INPUT_BYTES = 5 * 1024 * 1024;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type CanonicalJsonVersion = 1 | 2;
// Retained digest owners use v1 until they explicitly version their storage.
// V2 uses UTF-16 code-unit order, not locale collation or Unicode normalization.

const canonicalJsonValue = (
  value: unknown,
  path = "$",
  seen = new Set<object>(),
  locale?: string,
  version: CanonicalJsonVersion = 1,
): JsonValue => {
  const t = documentServiceText(locale);
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.includes("\0")) throw err.badInput(t.jsonNoNul({ path }));
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw err.badInput(t.jsonFiniteNumbers({ path }));
    return value;
  }
  if (typeof value !== "object") throw err.badInput(t.jsonValuesOnly({ path }));
  if (seen.has(value)) throw err.badInput(t.jsonNoCycles({ path }));
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from(value, (item, index) => canonicalJsonValue(item, `${path}[${index}]`, seen, locale, version));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw err.badInput(t.jsonPlainObjects({ path }));
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (version === 1 ? left.localeCompare(right) : left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => {
          if (key.includes("\0")) throw err.badInput(t.jsonKeyNoNul({ path }));
          return [key, canonicalJsonValue(item, `${path}.${key}`, seen, locale, version)];
        }),
    );
  } finally {
    seen.delete(value);
  }
};

export const canonicalJson = (
  value: Record<string, unknown>,
  locale?: string,
  version: CanonicalJsonVersion = 1,
): { value: Record<string, JsonValue>; json: string; sha256: string } => {
  const t = documentServiceText(locale);
  const canonical = canonicalJsonValue(value, "$", new Set(), locale, version);
  if (!canonical || Array.isArray(canonical) || typeof canonical !== "object") throw err.badInput(t.documentJsonObject);
  const json = JSON.stringify(canonical);
  return { value: canonical, json, sha256: createHash("sha256").update(json).digest("hex") };
};

export const canonicalDocumentJson = (
  value: Record<string, unknown>,
  locale?: string,
  version: CanonicalJsonVersion = 1,
): { value: Record<string, JsonValue>; json: string; sha256: string } => {
  const t = documentServiceText(locale);
  const canonical = canonicalJson(value, locale, version);
  if (new TextEncoder().encode(canonical.json).byteLength > MAX_DOCUMENT_PROFILE_INPUT_BYTES) {
    throw err.badInput(t.documentJsonTooLarge({ limit: MAX_DOCUMENT_PROFILE_INPUT_BYTES }));
  }
  return canonical;
};
