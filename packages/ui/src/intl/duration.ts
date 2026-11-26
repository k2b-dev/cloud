/**
 * The one wording of a span of time in `@k2b/ui`, as the calendar has always written it ("12 min", "1 hr 30 min";
 * "12 Min", "1 Std. 30"), from seconds to days. The calendar and the charts take it through their message catalogs,
 * so a span reads the same wherever the library shows one.
 *
 * Under a minute it counts seconds, one decimal below ten; under a day hours and minutes; from a day on days and hours.
 */
const parts = (milliseconds: number) => {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 59.5) return { seconds: Math.round(seconds * (seconds < 10 ? 10 : 1)) / (seconds < 10 ? 10 : 1) };
  const minutes = Math.round(seconds / 60);
  if (minutes < 24 * 60) return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
  const hours = Math.round(minutes / 60);
  return { days: Math.floor(hours / 24), hours: hours % 24 };
};

export const durationWords = {
  en: (milliseconds: number): string => {
    const span = parts(milliseconds);
    if (span.seconds !== undefined) return `${span.seconds.toLocaleString("en")} sec`;
    if (span.days !== undefined) return `${span.days} ${span.days === 1 ? "day" : "days"}${span.hours ? ` ${span.hours} hr` : ""}`;
    if (!span.hours) return `${span.minutes} min`;
    return `${span.hours} hr${span.minutes ? ` ${span.minutes} min` : span.hours === 1 ? "" : "s"}`;
  },
  de: (milliseconds: number): string => {
    const span = parts(milliseconds);
    if (span.seconds !== undefined) return `${span.seconds.toLocaleString("de")} Sek.`;
    if (span.days !== undefined) return `${span.days} ${span.days === 1 ? "Tag" : "Tage"}${span.hours ? ` ${span.hours} Std.` : ""}`;
    if (!span.hours) return `${span.minutes} Min`;
    return span.minutes ? `${span.hours} Std. ${span.minutes}` : `${span.hours} Std.`;
  },
};

/** The wording for a locale outside a message catalog (a drawing rendered without `Chart`): German or English. */
export const durationIn = (locale = "en") => (/^de\b/i.test(locale) ? durationWords.de : durationWords.en);
