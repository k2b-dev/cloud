export const SEEN_HINTS_COOKIE = "cloud_seen_hints";
export const SEEN_HINTS_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
export const MAX_SEEN_HINTS = 64;

const COOKIE_ATTRIBUTES = `; Path=/; Max-Age=${SEEN_HINTS_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
// RFC 6265's 4096-byte budget includes name, value and attributes. Reserve Secure on HTTP too.
const MAX_COOKIE_VALUE_LENGTH = 4096 - `${SEEN_HINTS_COOKIE}=${COOKIE_ATTRIBUTES}; Secure`.length;

export const isHintId = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id);

/** Keep the most recent occurrence, with the newest hints last. */
const normalize = (ids: readonly string[]): string[] => {
  const recent = [...new Set(ids.filter(isHintId).toReversed())].reverse().slice(-MAX_SEEN_HINTS);
  while (recent.join("~").length > MAX_COOKIE_VALUE_LENGTH) recent.shift();
  return recent;
};

export const parseSeenHintsCookieHeader = (header: string | null | undefined): string[] => {
  const value = header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SEEN_HINTS_COOKIE}=`))
    ?.slice(SEEN_HINTS_COOKIE.length + 1);
  return normalize(value?.split("~") ?? []);
};

export const serializeSeenHints = (ids: readonly string[]): string => normalize(ids).join("~");

export const mergeSeenHints = (current: readonly string[], id: string): string[] => {
  if (!isHintId(id)) throw new Error(`Invalid hint id: ${id}`);
  return normalize([...current, id]);
};

export const seenHintsSetCookie = (ids: readonly string[], secure: boolean): string =>
  `${SEEN_HINTS_COOKIE}=${serializeSeenHints(ids)}${COOKIE_ATTRIBUTES}${secure ? "; Secure" : ""}`;
