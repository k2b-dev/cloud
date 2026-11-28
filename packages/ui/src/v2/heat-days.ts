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

export type HeatGrid = {
  /** The date keys of each weekday row, oldest week first; days after `today` are left out. */
  rows: string[][];
  /** The count and tone of each day shown that has a count. */
  days: Map<string, { count: number; tone: number }>;
  /** The sum of the counts of the days shown, and how many days that is. */
  total: number;
  span: number;
};

/**
 * The scale every day shares, over the distinct counts above 0: each distinct count takes the tone of the quarter it
 * falls in, so the busiest day is always the strongest tone, equal counts share one tone, and one busy day does not
 * leave every other day at the softest tone.
 */
export const heatScale = (counts: Iterable<number>): ((count: number) => number) => {
  const distinct = [...new Set([...counts].filter((count) => count > 0))].sort((a, b) => a - b);
  const rank = new Map(distinct.map((count, index) => [count, index]));
  return (count) => {
    const at = rank.get(count);
    return at === undefined ? 0 : Math.ceil((heatTones * (at + 1)) / distinct.length);
  };
};

/**
 * The 53 weeks that end with the week of `today`. Counts outside these days, below 1 or not finite are ignored, and
 * two counts for one day add up.
 */
export const heatGrid = (input: readonly HeatDay[], today: string, weekStartsOn: number): HeatGrid => {
  const first = addDays(startOfWeek(today, weekStartsOn), -7 * (heatWeeks - 1));
  const counts = new Map<string, number>();
  for (const day of input) {
    if (day.date < first || day.date > today || !Number.isFinite(day.count) || day.count <= 0) continue;
    counts.set(day.date, (counts.get(day.date) ?? 0) + day.count);
  }
  const tone = heatScale(counts.values());
  const rows = Array.from({ length: 7 }, (_, row) => {
    const dates: string[] = [];
    for (let week = 0; week < heatWeeks; week += 1) {
      const date = addDays(first, week * 7 + row);
      if (date > today) break;
      dates.push(date);
    }
    return dates;
  });
  const days = new Map([...counts].map(([date, count]) => [date, { count, tone: tone(count) }]));
  return {
    rows,
    days,
    total: [...counts.values()].reduce((sum, count) => sum + count, 0),
    span: rows.reduce((sum, row) => sum + row.length, 0),
  };
};

/**
 * Where a month begins: the week that holds its first day, and how many weeks it has until the next one. A month
 * with fewer than three weeks in view is left out, so no two names touch. The current month keeps its name from its
 * first day: while it has fewer than three weeks, it takes the place of the month before and stands at its end.
 */
export const heatMonths = (rows: readonly string[][]): { week: number; weeks: number; date: string; end?: true }[] => {
  const starts: { week: number; date: string }[] = [];
  for (let week = 0; week < heatWeeks; week += 1) {
    const day = rows.map((row) => row[week]).find((date) => date?.endsWith("-01"));
    if (day) starts.push({ week, date: day });
  }
  const months = starts.map((start, index) => ({ ...start, weeks: (starts[index + 1]?.week ?? heatWeeks) - start.week }));
  const current = months.at(-1);
  const before = months.at(-2);
  const named = months.filter((month) => month.weeks >= 3);
  if (!current || current.weeks >= 3) return named;
  return [
    ...named.filter((month) => month !== before),
    { week: before?.week ?? current.week, weeks: (before?.weeks ?? 0) + current.weeks, date: current.date, end: true as const },
  ];
};
