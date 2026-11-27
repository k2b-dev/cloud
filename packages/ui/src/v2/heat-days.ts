/**
 * The days of a `Heat`: the last 53 weeks up to a day, as seven rows of weekdays with one column per week, and the
 * tone of each day from a scale all its days share. Pure: date keys in, date keys out. Week start and day arithmetic
 * are core's (`behavior/dates`), the same a `DatePicker` uses.
 */
import { addDays, startOfWeek } from "./behavior/dates";

/** The weeks a `Heat` shows: a full year and the week it began in. */
export const heatWeeks = 53;

/** How many tones a day with a count can take; a day without one stands quiet. */
export const heatTones = 4;

export type HeatDay = {
  /** The day, as a date key such as "2026-11-27". */
  date: string;
  /** What happened on it, such as the mails received; at least 0. */
  count: number;
};

export type HeatCell = { date: string; count: number; tone: number };

/**
 * The scale every day shares: the counts above 0 split into four equal shares (quartiles), so one day of many does
 * not leave every other day at the softest tone. A day above the last bound takes the strongest tone.
 */
export const heatBounds = (counts: readonly number[]): number[] => {
  const sorted = counts.filter((count) => count > 0).sort((a, b) => a - b);
  if (!sorted.length) return [];
  return [1, 2, 3].map((share) => sorted[Math.max(0, Math.ceil((sorted.length * share) / heatTones) - 1)]!);
};

/** The tone of a count on the shared scale: 0 for nothing, 1 to 4 from soft to strong. */
export const heatTone = (count: number, bounds: readonly number[]): number => {
  if (count <= 0 || !bounds.length) return 0;
  const below = bounds.findIndex((bound) => count <= bound);
  return below === -1 ? heatTones : below + 1;
};

/**
 * The cells of the 53 weeks that end with the week of `today`: `rows[weekday][week]`, oldest week first. Days after
 * `today` are left out, so a row may be one cell shorter than another. Counts outside these days are ignored, and
 * two counts for one day add up.
 */
export const heatRows = (days: readonly HeatDay[], today: string, weekStartsOn: number): HeatCell[][] => {
  const first = addDays(startOfWeek(today, weekStartsOn), -7 * (heatWeeks - 1));
  const counts = new Map<string, number>();
  for (const day of days) {
    if (day.date < first || day.date > today || !(day.count > 0)) continue;
    counts.set(day.date, (counts.get(day.date) ?? 0) + day.count);
  }
  const bounds = heatBounds([...counts.values()]);
  return Array.from({ length: 7 }, (_, row) => {
    const cells: HeatCell[] = [];
    for (let week = 0; week < heatWeeks; week += 1) {
      const date = addDays(first, week * 7 + row);
      if (date > today) break;
      const count = counts.get(date) ?? 0;
      cells.push({ date, count, tone: heatTone(count, bounds) });
    }
    return cells;
  });
};

/**
 * Where a month begins: the week that holds its first day, and how many weeks it has until the next one. A month
 * with fewer than three weeks in view (the first, cut by the start) is left out, so no two names touch.
 */
export const heatMonths = (rows: readonly HeatCell[][]): { week: number; weeks: number; date: string }[] => {
  const starts: { week: number; date: string }[] = [];
  for (let week = 0; week < heatWeeks; week += 1) {
    const day = rows.map((row) => row[week]?.date).find((date) => date?.endsWith("-01"));
    if (day) starts.push({ week, date: day });
  }
  return starts
    .map((start, index) => ({ ...start, weeks: (starts[index + 1]?.week ?? heatWeeks) - start.week }))
    .filter((month) => month.weeks >= 3);
};
