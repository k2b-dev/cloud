import { type DateContext, dates } from "@k2b/stdlib";

/**
 * A planned end typed as a clock time (`14:30`, `1430`, `9:30`, `14`) for today in the viewer's time zone. As in
 * `cld admin maintenance --until`, a time that has already passed is rejected, never moved to tomorrow.
 */
export const parseEndTime = (
  value: string,
  timeZone: string,
  now = Date.now(),
): { ok: true; iso: string } | { ok: false; reason: "format" | "past" } => {
  const clock = /^(\d{1,2})(?:[:.]?(\d{2}))?$/.exec(value.trim());
  if (!clock) return { ok: false, reason: "format" };
  const hours = Number(clock[1]);
  const minutes = Number(clock[2] ?? "0");
  if (hours > 23 || minutes > 59) return { ok: false, reason: "format" };
  const [today] = dates.instantToZonedInput(new Date(now), timeZone).split("T");
  const iso = dates.zonedDateTimeToInstant(
    `${today}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
    timeZone,
    { disambiguation: "compatible" },
  );
  return Date.parse(iso) <= now ? { ok: false, reason: "past" } : { ok: true, iso };
};

/** `14:02` today, otherwise with the date, in the viewer's time zone. */
export const formatClock = (iso: string, context: DateContext, now = Date.now()): string =>
  dates.isSameDay(new Date(iso), new Date(now), context) ? dates.formatTime(iso, context) : dates.formatDateTime(iso, context);
