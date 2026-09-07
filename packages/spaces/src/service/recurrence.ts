import { type DateContext, dates } from "@k2b/stdlib";

export type RecurringFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export type RecurrenceRule = {
  freq: RecurringFrequency;
  interval: number;
  count?: number;
  until?: Date;
  byDay?: number[];
};

export type RecurringEvent = {
  id: string;
  title: string;
  start: string | Date;
  end: string | Date;
  allDay?: boolean;
  recurrence?: {
    rrule: string;
    dtstart?: string | Date;
    exdate?: Array<string | Date>;
  };
};

export type RecurringOverride = Omit<RecurringEvent, "recurrence"> & {
  recurringEventId: string;
  recurrenceId: string | Date;
};

export type ExpandedRecurringEvent = RecurringEvent & {
  recurringInstance?: {
    isRecurringInstance: true;
    recurringEventId: string;
    recurrenceId: string;
    originalStart: string;
    originalEnd: string;
  };
};

type ExpandRecurringEventsParams = {
  requireComplete?: boolean;
  events: RecurringEvent[];
  overrides?: RecurringOverride[];
  rangeStart: string | Date;
  rangeEnd: string | Date;
  expansionLimit?: number;
  generationLimit?: number;
  dateConfig?: DateContext;
};

export type ResolvedRecurringOccurrence = {
  recurrenceId: string;
  start: string;
  end: string;
  allDay: boolean;
};

export type SplitRecurringEvent = {
  isFirstOccurrence: boolean;
  previousRrule: string;
  previousExdate: string[];
  nextRrule: string;
  nextExdate: string[];
};

export class CalendarReadLimitError extends Error {}
const DEFAULT_EXPANSION_LIMIT = 2000;
export const MAX_OCCURRENCE_LOOKUP_STEPS = 10_000;
const SUPPORTED_RRULE_PARTS = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY"]);
const WEEKDAY_INDEX: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

const toDate = (value: string | Date): Date => (value instanceof Date ? new Date(value) : new Date(value));
const toIso = (date: Date): string => date.toISOString();
const sameInstantKey = (value: string | Date): string => toIso(toDate(value));
const compactUtc = (date: Date): string =>
  `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}T${String(
    date.getUTCHours(),
  ).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}${String(date.getUTCSeconds()).padStart(2, "0")}Z`;

const addWallTime = (
  date: Date,
  context: DateContext | undefined,
  options: { years?: number; months?: number; weeks?: number; days?: number },
): Date => {
  if (context?.timeZone) {
    return new Date(dates.addZonedInstant(date, { timeZone: context.timeZone, ...options, disambiguation: "compatible" }));
  }
  return new Date(
    date.getFullYear() + (options.years ?? 0),
    date.getMonth() + (options.months ?? 0),
    date.getDate() + (options.weeks ?? 0) * 7 + (options.days ?? 0),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
};

const parseUntil = (value: string): Date => {
  let parsed: Date;
  let expectedDateKey: string | undefined;
  if (/^\d{8}T\d{6}Z$/.test(value)) {
    const year = value.slice(0, 4);
    const month = value.slice(4, 6);
    const day = value.slice(6, 8);
    const hour = value.slice(9, 11);
    const minute = value.slice(11, 13);
    const second = value.slice(13, 15);
    parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    expectedDateKey = value;
  } else if (/^\d{8}$/.test(value)) {
    parsed = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T23:59:59.999Z`);
    expectedDateKey = value;
  } else {
    parsed = new Date(value);
  }
  if (Number.isNaN(parsed.getTime())) throw new Error("Recurrence UNTIL must be a valid date");
  if (
    expectedDateKey &&
    (expectedDateKey.length === 8 ? compactUtc(parsed).slice(0, 8) !== expectedDateKey : compactUtc(parsed) !== expectedDateKey)
  ) {
    throw new Error("Recurrence UNTIL must be a valid date");
  }
  return parsed;
};

export const parseRecurrenceRule = (rrule: string): RecurrenceRule => {
  const parts = new Map<string, string>();
  for (const rawPart of rrule.split(";")) {
    const part = rawPart.trim();
    if (!part) continue;
    const separator = part.indexOf("=");
    if (separator <= 0 || separator === part.length - 1) throw new Error("Recurrence rule contains an invalid part");
    const key = part.slice(0, separator).trim().toUpperCase();
    const value = part
      .slice(separator + 1)
      .trim()
      .toUpperCase();
    if (!SUPPORTED_RRULE_PARTS.has(key)) throw new Error(`Recurrence rule part ${key} is not supported`);
    if (parts.has(key)) throw new Error(`Recurrence rule contains duplicate ${key}`);
    parts.set(key, value);
  }

  const freq = parts.get("FREQ") as RecurringFrequency | undefined;
  if (!freq || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) {
    throw new Error("Recurrence rule requires FREQ=DAILY|WEEKLY|MONTHLY|YEARLY");
  }

  const interval = Number(parts.get("INTERVAL") ?? "1");
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error("Recurrence INTERVAL must be a positive integer");
  }

  const countRaw = parts.get("COUNT");
  const count = countRaw === undefined ? undefined : Number(countRaw);
  if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
    throw new Error("Recurrence COUNT must be a positive integer");
  }

  const byDayParts = parts.get("BYDAY")?.split(",") ?? [];
  if (byDayParts.some((day) => WEEKDAY_INDEX[day] === undefined)) {
    throw new Error("Recurrence BYDAY must contain valid weekdays");
  }
  if (byDayParts.length > 0 && freq !== "WEEKLY") {
    throw new Error("Recurrence BYDAY is only supported for weekly rules");
  }
  const byDay = byDayParts.map((day) => WEEKDAY_INDEX[day]!).filter((day, index, days) => days.indexOf(day) === index);

  return {
    freq,
    interval,
    count,
    until: parts.has("UNTIL") ? parseUntil(parts.get("UNTIL")!) : undefined,
    byDay: byDay && byDay.length > 0 ? byDay : undefined,
  };
};

const zonedWeekday = (date: Date, context?: DateContext): number => {
  if (!context?.timeZone) return date.getDay();
  const key = dates.formatDateKey(date, context);
  const [year = "1970", month = "1", day = "1"] = key.split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay();
};

const nextCursor = (date: Date, rule: RecurrenceRule, context?: DateContext): Date => {
  if (rule.freq === "DAILY") return addWallTime(date, context, { days: rule.interval });
  if (rule.freq === "WEEKLY") return addWallTime(date, context, { weeks: rule.interval });
  if (rule.freq === "MONTHLY") return addWallTime(date, context, { months: rule.interval });
  return addWallTime(date, context, { years: rule.interval });
};

const weeklyCandidates = (weekStart: Date, rule: RecurrenceRule, fallbackDay: number, context?: DateContext): Date[] => {
  const days = rule.byDay ?? [fallbackDay];
  return days
    .map((day) => addWallTime(weekStart, context, { days: day - zonedWeekday(weekStart, context) }))
    .sort((a, b) => a.getTime() - b.getTime());
};

const overlapsRange = (start: Date, end: Date, rangeStart: Date, rangeEnd: Date): boolean => start < rangeEnd && end > rangeStart;

export const expandRecurringEvents = (params: ExpandRecurringEventsParams): ExpandedRecurringEvent[] => {
  const rangeStart = toDate(params.rangeStart);
  const rangeEnd = toDate(params.rangeEnd);
  const dateConfig = params.dateConfig;
  const expansionLimit = params.expansionLimit ?? DEFAULT_EXPANSION_LIMIT;
  const generationLimit = params.generationLimit ?? Number.POSITIVE_INFINITY;
  const overrides = new Map(
    (params.overrides ?? []).map((event) => [`${event.recurringEventId}:${sameInstantKey(event.recurrenceId)}`, event]),
  );
  const output: ExpandedRecurringEvent[] = [];

  for (const event of params.events) {
    const start = toDate(event.start);
    const end = toDate(event.end);
    const duration = end.getTime() - start.getTime();

    if (!event.recurrence) {
      if (overlapsRange(start, end, rangeStart, rangeEnd)) output.push(event);
      continue;
    }

    const rule = parseRecurrenceRule(event.recurrence.rrule);
    const seriesStart = event.recurrence.dtstart ? toDate(event.recurrence.dtstart) : start;
    const exdates = new Set((event.recurrence.exdate ?? []).map(sameInstantKey));
    let emitted = 0;
    // Replacement times may move into or out of this range independently of their original instant.
    for (const override of overrides.values()) {
      if (override.recurringEventId !== event.id || exdates.has(sameInstantKey(override.recurrenceId))) continue;
      if (overlapsRange(toDate(override.start), toDate(override.end), rangeStart, rangeEnd)) {
        output.push({ ...override, recurringInstance: undefined });
        emitted += 1;
        if (emitted >= expansionLimit) break;
      }
    }
    let generated = 0;
    let cursor = seriesStart;
    let done = false;

    while (!done && emitted < expansionLimit && generated < generationLimit) {
      const candidates =
        rule.freq === "WEEKLY" ? weeklyCandidates(cursor, rule, zonedWeekday(seriesStart, dateConfig), dateConfig) : [cursor];

      for (const candidate of candidates) {
        if (candidate < seriesStart) continue;
        if (generated >= generationLimit) {
          done = true;
          break;
        }
        if (rule.until && candidate > rule.until) {
          done = true;
          break;
        }
        generated += 1;
        if (rule.count && generated > rule.count) {
          done = true;
          break;
        }

        const occurrenceEnd = new Date(candidate.getTime() + duration);
        if (occurrenceEnd <= rangeStart) continue;
        if (candidate >= rangeEnd) {
          done = true;
          break;
        }

        const recurrenceId = toIso(candidate);
        if (exdates.has(recurrenceId)) continue;

        const override = overrides.get(`${event.id}:${recurrenceId}`);
        if (!override && overlapsRange(candidate, occurrenceEnd, rangeStart, rangeEnd)) {
          output.push({
            ...event,
            id: `${event.id}:${recurrenceId}`,
            start: recurrenceId,
            end: toIso(occurrenceEnd),
            recurringInstance: {
              isRecurringInstance: true,
              recurringEventId: event.id,
              recurrenceId,
              originalStart: recurrenceId,
              originalEnd: toIso(occurrenceEnd),
            },
          });
        }

        if (!override) emitted += 1;
        if (emitted >= expansionLimit) break;
      }

      cursor = nextCursor(cursor, rule, dateConfig);
    }
    if (params.requireComplete && (emitted >= expansionLimit || generated >= generationLimit)) {
      throw new CalendarReadLimitError("Recurrence budget exceeded; narrow the calendar range or inspect the series directly.");
    }
  }

  return output.sort((a, b) => toDate(a.start).getTime() - toDate(b.start).getTime());
};

/**
 * Resolves one generated occurrence from its original start instant.
 *
 * The original instant is the stable identity used by RFC 5545 overrides and
 * occurrence-scoped comments. A bounded expansion keeps crafted timestamps
 * from turning detail or comment requests into unbounded recurrence work.
 */
export const resolveRecurringOccurrence = (params: {
  event: RecurringEvent;
  recurrenceId: string;
  dateConfig?: DateContext;
}): ResolvedRecurringOccurrence | null => {
  const recurrenceDate = new Date(params.recurrenceId);
  if (Number.isNaN(recurrenceDate.getTime())) return null;
  const recurrenceId = recurrenceDate.toISOString();
  let occurrence: ExpandedRecurringEvent | undefined;
  try {
    [occurrence] = expandRecurringEvents({
      events: [params.event],
      rangeStart: recurrenceDate,
      rangeEnd: new Date(recurrenceDate.getTime() + 1),
      expansionLimit: DEFAULT_EXPANSION_LIMIT,
      generationLimit: MAX_OCCURRENCE_LOOKUP_STEPS,
      dateConfig: params.dateConfig,
    }).filter((event) => event.recurringInstance?.recurrenceId === recurrenceId);
  } catch {
    return null;
  }
  if (!occurrence?.recurringInstance) return null;

  return {
    recurrenceId,
    start: toIso(toDate(occurrence.start)),
    end: toIso(toDate(occurrence.end)),
    allDay: occurrence.allDay ?? false,
  };
};

const recurrenceParts = (rrule: string): string[] =>
  rrule
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

const withoutRecurrenceBounds = (parts: string[]): string[] =>
  parts.filter((part) => !part.toUpperCase().startsWith("UNTIL=") && !part.toUpperCase().startsWith("COUNT="));

const withoutUntil = (parts: string[]): string[] => parts.filter((part) => !part.toUpperCase().startsWith("UNTIL="));

const shiftedUntilPart = (rule: RecurrenceRule, milliseconds: number): string[] =>
  rule.until ? [`UNTIL=${compactUtc(new Date(rule.until.getTime() + milliseconds))}`] : [];

/**
 * Moves an absolute recurrence boundary together with a shifted series.
 * COUNT remains unchanged because the number of occurrences does not change.
 */
export const shiftRecurrenceRule = (rrule: string, milliseconds: number): string => {
  if (milliseconds === 0) return rrule;
  const rule = parseRecurrenceRule(rrule);
  if (!rule.until) return rrule;
  return [...withoutUntil(recurrenceParts(rrule)), ...shiftedUntilPart(rule, milliseconds)].join(";");
};

/**
 * Splits a recurring event immediately before one generated occurrence.
 *
 * The old series keeps preceding exceptions. The new series keeps and shifts
 * future exceptions, COUNT's remaining cardinality, and an absolute UNTIL
 * boundary. A bounded ordinal lookup rejects stale or crafted occurrence ids.
 */
export const splitRecurringEvent = (params: {
  event: RecurringEvent;
  recurrenceId: string;
  nextStart: string;
  dateConfig?: DateContext;
}): SplitRecurringEvent | null => {
  const occurrence = resolveRecurringOccurrence({
    event: params.event,
    recurrenceId: params.recurrenceId,
    dateConfig: params.dateConfig,
  });
  if (!occurrence || !params.event.recurrence) return null;

  const nextStart = new Date(params.nextStart);
  if (Number.isNaN(nextStart.getTime())) return null;
  const recurrenceDate = new Date(occurrence.recurrenceId);
  const shiftMilliseconds = nextStart.getTime() - recurrenceDate.getTime();
  const rule = parseRecurrenceRule(params.event.recurrence.rrule);
  const parts = withoutRecurrenceBounds(recurrenceParts(params.event.recurrence.rrule));
  const previousRrule = [...parts, `UNTIL=${compactUtc(new Date(recurrenceDate.getTime() - 1))}`].join(";");

  const ordinalEvents = expandRecurringEvents({
    events: [
      {
        ...params.event,
        recurrence: { ...params.event.recurrence, exdate: [] },
      },
    ],
    rangeStart: params.event.recurrence.dtstart ?? params.event.start,
    rangeEnd: new Date(recurrenceDate.getTime() + 1),
    expansionLimit: MAX_OCCURRENCE_LOOKUP_STEPS,
    generationLimit: MAX_OCCURRENCE_LOOKUP_STEPS,
    dateConfig: params.dateConfig,
  });
  const ordinal = ordinalEvents.findIndex((event) => event.recurringInstance?.recurrenceId === occurrence.recurrenceId);
  if (ordinal < 0) return null;

  let remainingCount: number | undefined;
  if (rule.count !== undefined) {
    remainingCount = rule.count - ordinal;
    if (remainingCount < 1) return null;
  }

  const nextRrule = [
    ...parts,
    ...shiftedUntilPart(rule, shiftMilliseconds),
    ...(remainingCount === undefined ? [] : [`COUNT=${remainingCount}`]),
  ].join(";");
  const exdates = (params.event.recurrence.exdate ?? []).map(sameInstantKey);

  return {
    isFirstOccurrence: ordinal === 0,
    previousRrule,
    previousExdate: exdates.filter((value) => value < occurrence.recurrenceId),
    nextRrule,
    nextExdate: exdates.filter((value) => value >= occurrence.recurrenceId).map((value) => shiftIso(value, shiftMilliseconds)),
  };
};

const shiftIso = (value: string, milliseconds: number): string => new Date(new Date(value).getTime() + milliseconds).toISOString();
