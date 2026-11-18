import { describeCodeSchedule } from "../code/schedule";
import { cronRangeHasCalendarMatch, normalizeCronSchedule, visitCronDaySlots } from "../shared/cron-schedule";
import { AI_WAKEUP_LIFETIME_DAYS, AI_WAKEUP_MAX_YEARS, AI_WAKEUP_MIN_INTERVAL_MINUTES, type AiWakeupInput } from "./wakeup-contracts";

const DAY_MS = 86_400_000;
/** Reuse the platform cron grammar and DST semantics. The alarm's 30-day lifetime bounds this search. */
export function nextAiWakeupAt(cron: string, timezone: string, after: Date, end: Date): Date | null {
  // Start one day earlier so repeated local minutes across a DST rollback are remembered,
  // including when the prior occurrence was already delivered before this call.
  const seen = new Set<string>();
  const local = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (let start = +after - 26 * 3_600_000; start <= +end; start += DAY_MS) {
    const from = new Date(start), to = new Date(Math.min(start + DAY_MS, +end + 1));
    if (!cronRangeHasCalendarMatch({ cron, timezone }, from, to)) continue;
    let next: Date | null = null;
    visitCronDaySlots({ cron, timezone }, from, to, (slot) => {
      const key = local.format(slot);
      if (seen.has(key)) return;
      seen.add(key);
      if (+slot > +after) next ??= slot;
    });
    if (next) return next;
  }
  return null;
}

/** Checking the minute/hour wheel also catches short gaps across adjacent hours (e.g. 0,59). */
export function validateAiWakeupCron(cron: string, timezone: string) {
  const schedule = normalizeCronSchedule({ cron, timezone });
  const fields = schedule.cron.split(" ");
  const start = new Date("2026-01-01T00:00:00Z");
  const minutes: number[] = [];
  visitCronDaySlots({ cron: `${fields[0]} ${fields[1]} * * *`, timezone: "UTC" }, start, new Date(+start + DAY_MS), (slot) => {
    minutes.push((+slot - +start) / 60_000);
  });
  for (let i = 0; i < minutes.length; i++) {
    const gap = minutes[(i + 1) % minutes.length]! + (i === minutes.length - 1 ? 1440 : 0) - minutes[i]!;
    if (gap < AI_WAKEUP_MIN_INTERVAL_MINUTES) throw new Error("Alarms must be at least 15 minutes apart.");
  }
  return schedule;
}

export function prepareAiWakeupTime(input: AiWakeupInput, now: Date) {
  const timezone = new Intl.DateTimeFormat("en", { timeZone: input.timezone.trim() }).resolvedOptions().timeZone;
  const cron = input.cron ? validateAiWakeupCron(input.cron, timezone).cron : null;
  const maximum = new Date(now);
  maximum.setUTCFullYear(maximum.getUTCFullYear() + AI_WAKEUP_MAX_YEARS);
  const endsAt = cron ? new Date(input.endsAt ?? +now + AI_WAKEUP_LIFETIME_DAYS * DAY_MS) : null;
  if (endsAt && (+endsAt <= +now || +endsAt > +now + AI_WAKEUP_LIFETIME_DAYS * DAY_MS))
    throw new Error("Recurring alarms end within 30 days; extend them when needed.");
  if (!cron && input.endsAt) throw new Error("Only recurring alarms have an end date.");
  const at = input.at ? new Date(input.at) : cron && endsAt ? nextAiWakeupAt(cron, timezone, now, endsAt) : null;
  if (!at || !Number.isFinite(+at) || +at <= +now || +at > +maximum || (endsAt && +at > +endsAt))
    throw new Error("Choose a future time within the alarm's lifetime.");
  return { nextAt: at, cron, timezone, endsAt };
}

/** Arbitrary cron expressions never leak into product text. */
export function describeAiWakeupRhythm(cron: string | null, locale: string): string {
  const de = locale.startsWith("de");
  if (!cron) return de ? "Einmalig" : "Once";
  const described = describeCodeSchedule(cron, locale);
  return described === cron ? (de ? "Eigener Rhythmus" : "Custom schedule") : described;
}
