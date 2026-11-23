// ==========================
// URL Search Parameter Utilities
// ==========================

/**
 * Utility type that makes every property of `T` optional and allows `undefined`.
 *
 * Used throughout the search-params module to represent partially
 * deserialized or partially specified parameter objects where any key
 * may be absent or explicitly `undefined`.
 */
type MakeOptionalUndefined<T> = {
  [K in keyof T]?: T[K] | undefined;
};

/**
 * Checks whether a value is a primitive type that can be serialized
 * directly via `String()` without JSON encoding.
 *
 * Recognized primitives: `string`, `number`, and `boolean`.
 *
 * @param value - Value to test
 * @returns `true` if the value is a string, number, or boolean
 */
const isPrimitive = (value: any): boolean =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

/**
 * Determines whether a value should be removed from URL search parameters.
 *
 * The following values are considered "empty" and will cause the
 * corresponding parameter to be deleted during serialization:
 * - `undefined`
 * - `null`
 * - `false`
 * - `""` (empty string)
 *
 * @param value - Value to test
 * @returns `true` if the parameter should be removed
 */
const shouldRemoveParam = (value: any): boolean =>
  value === undefined || value === null || value === false || value === "";

/**
 * Deserializes URL search parameters into a typed object.
 *
 * Values are coerced using these rules (in order):
 * 1. `"true"` / `"false"` become booleans.
 * 2. Numeric strings are coerced to `number` only when the round-trip
 *    `String(Number(v)) === v` holds (prevents mangling of zero-padded
 *    strings like `"007"` or hex-like values).
 * 3. `"null"` is kept as the literal string `"null"`.
 * 4. Remaining values are attempted as `JSON.parse`; on failure the raw
 *    string is kept.
 *
 * When no `params` argument is provided, reads from `globalThis.location.search`
 * (browser environment).
 *
 * @param params - Optional `URLSearchParams` to deserialize (defaults to current browser location)
 * @returns Typed object with coerced values
 *
 * @example
 * // URL: ?page=2&active=true&name=John
 * const params = searchParams.deserialize<{ page: number; active: boolean; name: string }>();
 * // { page: 2, active: true, name: "John" }
 */
/**
 * Keys that, if assigned via square-bracket access on a plain object, would
 * mutate the object's prototype chain or expose other internals. Filtered
 * defensively so a hostile query string cannot poison the prototype.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const deserialize = <T extends Record<string, any>>(
  params?: URLSearchParams,
): MakeOptionalUndefined<T> => {
  const searchParams =
    params || new URLSearchParams(globalThis?.location?.search || "");
  // `Object.create(null)` keeps assignment from triggering prototype setters
  // even if a future caller forgets the FORBIDDEN_KEYS check.
  const result: any = Object.create(null);

  for (const [key, value] of searchParams) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (value === "true") {
      result[key] = true;
    } else if (value === "false") {
      result[key] = false;
    } else if (value.trim() !== "" && !isNaN(Number(value)) && String(Number(value)) === value) {
      result[key] = Number(value);
    } else if (value === "null") {
      result[key] = value; // keep as string "null"
    } else {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    }
  }

  return result;
};

/**
 * Serializes an object into a URL search string.
 *
 * Merges `newParams` into an existing `URLSearchParams` base (or the
 * current browser location when no base is provided). Values are handled
 * as follows:
 * - **Removed** if `undefined`, `null`, `false`, or `""` (via {@link shouldRemoveParam}).
 * - **Stringified directly** if the value is a primitive (`string`, `number`, `boolean`).
 * - **JSON-encoded** for arrays and objects.
 *
 * @param newParams - Object with values to serialize
 * @param params - Optional base `URLSearchParams` to merge into (defaults to current browser location)
 * @returns URL search string (without leading `"?"`)
 *
 * @example
 * searchParams.serialize({ page: 2, active: true }) // "page=2&active=true"
 */
export const serialize = <T extends Record<string, any>>(
  newParams: MakeOptionalUndefined<T>,
  params?: URLSearchParams,
): string => {
  const current = new URLSearchParams(
    params || globalThis?.location?.search || "",
  );

  for (const [key, value] of Object.entries(newParams)) {
    if (shouldRemoveParam(value)) {
      current.delete(key);
    } else if (isPrimitive(value)) {
      current.set(key, String(value));
    } else {
      current.set(key, JSON.stringify(value));
    }
  }

  return current.toString();
};

/**
 * Registers a listener for URL search-parameter changes in the browser.
 *
 * Listens for `popstate` events (browser back/forward navigation) and
 * invokes `callback` with freshly deserialized parameters.
 *
 * **Browser-only:** In non-browser environments (e.g. Node/Bun where
 * `window` is undefined), returns a no-op cleanup function immediately.
 *
 * @param callback - Called with deserialized params whenever the URL changes
 * @returns Cleanup function that removes the `popstate` listener
 *
 * @example
 * const cleanup = searchParams.onChange<{ page: number }>(
 *   (params) => console.log("Page:", params.page)
 * );
 * // Later: cleanup();
 */
export const onChange = <T extends Record<string, any>>(
  callback: (params: MakeOptionalUndefined<T>) => void,
): (() => void) => {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handlePopState = () => {
    const params = deserialize<T>();
    callback(params);
  };

  window.addEventListener("popstate", handlePopState);

  return () => {
    window.removeEventListener("popstate", handlePopState);
  };
};

export const searchParams = {
  deserialize,
  serialize,
  onChange,
} as const;
