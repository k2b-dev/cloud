/**
 * A five-field schedule as a short sentence for the common shapes ("Mondays 07:00", "every 15 minutes"). Anything
 * else stays the expression itself, so the page never guesses wrong.
 */
const DAYS = {
  en: {
    one: ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"],
    short: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  },
  de: {
    one: ["sonntags", "montags", "dienstags", "mittwochs", "donnerstags", "freitags", "samstags"],
    short: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
  },
} as const;

const number = (value: string, max: number): number | null => (/^\d+$/.test(value) && Number(value) <= max ? Number(value) : null);

const dayList = (field: string, lang: "en" | "de"): string | null => {
  const range = /^(\d)-(\d)$/.exec(field);
  if (range) {
    const [from, to] = [Number(range[1]) % 7, Number(range[2]) % 7];
    return `${DAYS[lang].short[from]}–${DAYS[lang].short[to]}`;
  }
  const days = field.split(",").map((day) => number(day, 7));
  if (days.some((day) => day === null)) return null;
  const indexes = days.map((day) => day! % 7);
  return indexes.length === 1 ? (DAYS[lang].one[indexes[0]!] ?? null) : indexes.map((day) => DAYS[lang].short[day]).join(", ");
};

export const describeCodeSchedule = (cron: string, locale: string): string => {
  const lang = locale.toLowerCase().startsWith("de") ? "de" : "en";
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const every = /^\*\/(\d+)$/.exec(minute);
  if (every && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*")
    return lang === "de" ? `alle ${every[1]} Minuten` : `every ${every[1]} minutes`;
  const m = number(minute, 59);
  if (m === null || month !== "*") return cron;
  if (hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") return lang === "de" ? `stündlich zur Minute ${m}` : `hourly at minute ${m}`;
  const h = number(hour, 23);
  if (h === null) return cron;
  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (dayOfMonth === "*" && dayOfWeek === "*") return lang === "de" ? `täglich ${time}` : `daily ${time}`;
  if (dayOfMonth === "*") {
    const days = dayList(dayOfWeek, lang);
    return days ? `${days} ${time}` : cron;
  }
  const day = number(dayOfMonth, 31);
  if (day !== null && dayOfWeek === "*") return lang === "de" ? `am ${day}. jedes Monats ${time}` : `monthly on day ${day} ${time}`;
  return cron;
};
