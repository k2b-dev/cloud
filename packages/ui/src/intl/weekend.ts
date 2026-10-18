/** Intl week data: weekend days as ISO numbers, 1 for Monday to 7 for Sunday. */
type WeekInfo = { weekend?: readonly number[] };
type LocaleWeekInfo = { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo };

/** Saturday and Sunday as JavaScript day numbers, for engines without week data and for an unknown locale. */
const fallbackWeekend: ReadonlySet<number> = new Set([6, 0]);
const cache = new Map<string, ReadonlySet<number>>();

/**
 * The weekend days of `locale` as JavaScript day numbers (0 for Sunday): Saturday and Sunday in Germany, Friday and
 * Saturday in Israel. The days come from the engine's Intl week data where it has them, otherwise Saturday and Sunday.
 * Without a locale the answer is Saturday and Sunday too, so a server render and the browser agree.
 */
export const weekendDays = (locale: string | undefined): ReadonlySet<number> => {
  if (!locale) return fallbackWeekend;
  const cached = cache.get(locale);
  if (cached) return cached;
  let days = fallbackWeekend;
  try {
    const intlLocale = new Intl.Locale(locale) as Intl.Locale & LocaleWeekInfo;
    const weekend = (intlLocale.getWeekInfo?.() ?? intlLocale.weekInfo)?.weekend;
    if (weekend?.length) days = new Set(weekend.map((day) => day % 7));
  } catch {
    // An invalid locale tag keeps Saturday and Sunday.
  }
  cache.set(locale, days);
  return days;
};

/** The day of the week of a date key such as `2026-10-24`, as a JavaScript day number (0 for Sunday). */
export const dayOfWeekOfKey = (key: string): number => {
  const [year = 1970, month = 1, day = 1] = key.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

/** Whether the day of `key` is a weekend day of `locale`. */
export const isWeekendKey = (key: string, locale: string | undefined): boolean => weekendDays(locale).has(dayOfWeekOfKey(key));

/** Whether column `index` of a week that starts on `firstDayOfWeek` (0 for Sunday, 1 for Monday) is a weekend day. */
export const isWeekendColumn = (index: number, firstDayOfWeek: number, locale: string | undefined): boolean =>
  weekendDays(locale).has((firstDayOfWeek + index) % 7);
