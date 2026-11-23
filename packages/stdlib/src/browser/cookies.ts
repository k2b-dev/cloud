/**
 * Cookie utilities for reading, writing, and deleting browser cookies.
 *
 * Provides both raw string and JSON-encoded cookie operations.
 * All writes default to `path=/`, `SameSite=Lax`, 1-year expiration, and
 * auto-detect HTTPS for the `Secure` flag.
 */

const DEFAULT_MAX_AGE = 31536000; // 1 year in seconds

/**
 * Reads a JSON-encoded cookie and parses it into the expected shape.
 *
 * If the cookie is missing or JSON parsing fails, returns `defaultValue` silently
 * (no error is thrown). When both `defaultValue` and the parsed value are plain
 * objects (not arrays), the result is shallow-merged (`{ ...defaultValue, ...parsed }`)
 * so that newly added fields in `defaultValue` are preserved.
 */
export const readJsonCookie = <T>(name: string, defaultValue: T): T => {
  try {
    const cookie = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
    if (cookie) {
      const eqIndex = cookie.indexOf("=");
      const value = decodeURIComponent(cookie.substring(eqIndex + 1));
      const parsed = JSON.parse(value);
      // Only merge if both default and parsed are plain objects
      if (typeof defaultValue === "object" && defaultValue !== null && !Array.isArray(defaultValue) &&
          typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return { ...defaultValue, ...parsed };
      }
      return parsed as T;
    }
  } catch {
    // Ignore parse errors, return default
  }
  return defaultValue;
};

/**
 * Validate that a cookie name is safe to interpolate into a Set-Cookie /
 * document.cookie header. Names containing `;`, `=`, whitespace, or control
 * chars can write/delete the wrong cookie or inject attributes.
 */
const assertSafeCookieName = (name: string): void => {
  // RFC 6265 cookie-name = token (no separators / control chars / whitespace).
  if (!name || /[;=,\s\x00-\x1f\x7f]/.test(name)) {
    throw new Error(`cookies: invalid cookie name ${JSON.stringify(name)}`);
  }
};

/**
 * Writes a value as a JSON-encoded cookie.
 *
 * The value is `JSON.stringify`'d and URI-encoded. Defaults: `path=/`,
 * `SameSite=Lax`, 1-year `max-age`. The `Secure` flag is set automatically
 * when the page is served over HTTPS.
 */
export const writeJsonCookie = <T>(name: string, data: T, maxAge = DEFAULT_MAX_AGE, secure = location.protocol === "https:") => {
  assertSafeCookieName(name);
  document.cookie = `${name}=${encodeURIComponent(JSON.stringify(data))}; path=/; max-age=${maxAge}; SameSite=Lax${secure ? "; Secure" : ""}`;
};

/**
 * Reads a raw string cookie value.
 *
 * Returns the URI-decoded value, or `null` if the cookie does not exist.
 * Returns the raw (still-encoded) value when decoding fails — a malformed
 * `%`-sequence written by another producer must not crash unrelated callers.
 */
export const readCookie = (name: string): string | null => {
  const cookie = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
  if (cookie) {
    const eqIndex = cookie.indexOf("=");
    const raw = cookie.substring(eqIndex + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      // Malformed percent-encoding from a third-party cookie — return the
      // raw string instead of throwing URIError.
      return raw;
    }
  }
  return null;
};

/**
 * Writes a raw string cookie value.
 *
 * The value is URI-encoded. Uses the same defaults as {@link writeJsonCookie}:
 * `path=/`, `SameSite=Lax`, 1-year `max-age`, auto `Secure` on HTTPS.
 */
export const writeCookie = (name: string, value: string, maxAge = DEFAULT_MAX_AGE, secure = location.protocol === "https:") => {
  assertSafeCookieName(name);
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax${secure ? "; Secure" : ""}`;
};

/**
 * Deletes a cookie by setting its `max-age` to 0.
 *
 * The browser removes the cookie on the next request. Only affects cookies
 * set on `path=/` with `SameSite=Lax`.
 */
export const deleteCookie = (name: string) => {
  assertSafeCookieName(name);
  document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
};

/** Cookie namespace exposing all cookie utilities. */
export const cookies = {
  readJsonCookie,
  writeJsonCookie,
  readCookie,
  writeCookie,
  deleteCookie,
} as const;
