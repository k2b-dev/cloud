export const TIMEZONE_COOKIE = "cloud.timezone";

/**
 * A time zone from a cookie, a setting or a request, as one canonical IANA name that formatting and the database read
 * the same way: Intl's own spelling of it ("utc" becomes "UTC"), or `fallback` when Intl does not know it. An offset
 * such as "+01:00" or "+0100" becomes UTC: Intl reads it as east of UTC, Postgres as POSIX, west of it, so the two
 * would put the borders of every day in different places.
 */
export const normalizeTimeZone = (value: string | null | undefined, fallback = "UTC"): string => {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) return fallback;
  if (/^[+-]/.test(candidate)) return "UTC";

  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return fallback;
  }
};
