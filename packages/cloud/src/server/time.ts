import type { DateContext } from "@k2b/stdlib";
import { normalizeTimeZone, TIMEZONE_COOKIE } from "../shared/time";
import { getLocale } from "./locale";
import { readCookie } from "./request-cookies";

export { TIMEZONE_COOKIE };

type TimeContext = {
  get(key: "settings"): Record<string, any> | undefined;
  req: { raw: { headers: Headers } };
};

export const getTimeZone = (c: TimeContext): string => {
  const settingsTimeZone = c.get("settings")?.app?.timezone;
  const fallback = normalizeTimeZone(typeof settingsTimeZone === "string" ? settingsTimeZone : undefined, "UTC");
  return normalizeTimeZone(readCookie(c.req.raw.headers, TIMEZONE_COOKIE), fallback);
};

/**
 * Request-scoped date config for stdlib formatters: the viewer's timezone and
 * the canonical request locale, resolved independently of each other.
 */
export const getDateConfig = (c: TimeContext): DateContext => ({
  timeZone: getTimeZone(c),
  locale: getLocale(c),
  firstDayOfWeek: 1,
});

export const time = {
  TIMEZONE_COOKIE,
  getTimeZone,
  getDateConfig,
} as const;
