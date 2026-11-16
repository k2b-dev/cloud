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
  // Hour ranges include every minute of their final hour (7-20 ends at 20:59).
  const hours = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(hour);
  const firstHour = Number(hours?.[1]);
  const lastHour = Number(hours?.[2] ?? hours?.[1]);
  const step = /^\*\/(\d+)$/.exec(minute);
  if (dayOfMonth === "*" && month === "*" && (minute === "*" || (step && Number(step[1]) >= 1 && Number(step[1]) <= 59))) {
    const frequency =
      minute === "*" || Number(step?.[1]) === 1
        ? lang === "de"
          ? "Jede Minute"
          : "Every minute"
        : lang === "de"
          ? `Alle ${step![1]} Minuten`
          : `Every ${step![1]} minutes`;
    const days = dayOfWeek === "*" ? "" : dayList(dayOfWeek, lang);
    if (days !== null && (hour === "*" || (hours && firstHour <= lastHour && lastHour <= 23))) {
      if (hours)
        return `${frequency}${lang === "de" ? ` von ${firstHour}:00 bis ${lastHour}:59 Uhr` : ` between ${firstHour}:00 and ${lastHour}:59`}${days ? ` · ${days}` : ""}`;
      if (minute === "*" || days) return `${frequency}${days ? ` · ${days}` : ""}`;
    }
  }
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

/**
 * When a scheduled automation runs: a one-time instant with its date, time and zone, else its repeating schedule; null
 * for an automation that no schedule starts. The Code page, the switch-on card and the administration read the same text.
 */
export const describeCodeTiming = (automation: { cron?: string | null; at?: string; timeZone?: string }, locale: string): string | null => {
  if (automation.at) {
    const timeZone = automation.timeZone ?? "UTC";
    return `${new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(automation.at))} (${timeZone})`;
  }
  return automation.cron ? describeCodeSchedule(automation.cron, locale) : null;
};

const dayKey = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

type CodeMomentOptions = { locale: string; timeZone: string; now?: Date };

/** The parts every Code moment is written from: whether it is today, its time, and its weekday with its day. */
const momentParts = (iso: string, options: CodeMomentOptions) => {
  const date = new Date(iso);
  const now = options.now ?? new Date();
  let timeZone = options.timeZone;
  try {
    dayKey(date, timeZone);
  } catch {
    timeZone = "UTC";
  }
  const lang = options.locale.toLowerCase().startsWith("de") ? "de" : "en";
  const time = new Intl.DateTimeFormat(options.locale, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  const otherYear = dayKey(date, timeZone).slice(0, 4) !== dayKey(now, timeZone).slice(0, 4);
  // Fixed weekday words: Intl writes a short weekday alone as "So" but inside a date as "So.", so surfaces that format
  // the day differently disagree. One fixed word per day keeps every Code surface alike.
  const index = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date),
  );
  const numeric = new Intl.DateTimeFormat(options.locale, {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    ...(otherYear ? { year: "numeric" } : {}),
  }).format(date);
  return {
    today: dayKey(date, timeZone) === dayKey(now, timeZone),
    todayWord: lang === "de" ? "heute" : "today",
    time,
    day: `${DAYS[lang].short[index] ?? ""}, ${numeric}`,
  };
};

/**
 * A moment of a Code as every Code surface writes it: "today, 15:28" on its day, "Sun, 11/15, 15:28" in the current
 * year, and with the year only in another one ("Sat, 11/15/2025, 15:28"). German reads "heute, 15:28",
 * "So, 15.11., 15:28" and "Sa, 15.11.2025, 15:28". The Code page, the chat's version card and event line, and
 * Gustav's Code blocks use it, so one instant reads the same everywhere. `now` is the clock that decides "today" and
 * "this year": pass the server's on the server and in the first browser render, so both show the same text.
 */
export const formatCodeMoment = (iso: string, options: CodeMomentOptions): string => {
  const parts = momentParts(iso, options);
  return parts.today ? `${parts.todayWord}, ${parts.time}` : `${parts.day}, ${parts.time}`;
};

/**
 * The day of a Code moment without its time, written like `formatCodeMoment`: "today", "Mon, 11/16", or with the year
 * outside the current one. German reads "heute", "Mo, 16.11." and "Mo, 16.11.2025". For lists that name only the day,
 * such as a card's next run.
 */
export const formatCodeDay = (iso: string, options: CodeMomentOptions): string => {
  const parts = momentParts(iso, options);
  return parts.today ? parts.todayWord : parts.day;
};
