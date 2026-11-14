/**
 * A line chart whose X values are instants (Unix milliseconds). Its axis ticks land on round times in `timeZone`:
 * minutes, hours, days, weeks, months, or years, whichever step keeps the requested number of ticks.
 */
export type ChartTimeAxis = {
  /** IANA zone whose wall clock the ticks follow, such as the zone the data's buckets use. */
  timeZone: string;
  /** Locale of the default tick labels; `xAxis.format` replaces them. Defaults to `en`. */
  locale?: string;
};

export type ChartTimeUnit = "minute" | "hour" | "day" | "week" | "month" | "year";
export type ChartTimeStep = { unit: ChartTimeUnit; size: number };

const STEPS: readonly ChartTimeStep[] = [
  ...[1, 2, 5, 10, 15, 30].map((size) => ({ unit: "minute" as const, size })),
  ...[1, 2, 3, 6, 12].map((size) => ({ unit: "hour" as const, size })),
  ...[1, 2].map((size) => ({ unit: "day" as const, size })),
  { unit: "week", size: 1 },
  ...[1, 3, 6].map((size) => ({ unit: "month" as const, size })),
  { unit: "year", size: 1 },
];
const UNIT_MS: Record<ChartTimeUnit, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_629_746_000,
  year: 31_556_952_000,
};

// Wall-clock arithmetic runs on a zone-free calendar: the wall time read as if it were UTC.
const floorWall = (wall: number, step: ChartTimeStep): number => {
  const date = new Date(wall);
  const y = date.getUTCFullYear(),
    m = date.getUTCMonth(),
    d = date.getUTCDate();
  if (step.unit === "minute") {
    const minutes = Math.floor(date.getUTCMinutes() / step.size) * step.size;
    return Date.UTC(y, m, d, date.getUTCHours(), minutes);
  }
  if (step.unit === "hour") return Date.UTC(y, m, d, Math.floor(date.getUTCHours() / step.size) * step.size);
  if (step.unit === "day") {
    const day = Date.UTC(y, m, d);
    return day - (Math.floor(day / UNIT_MS.day) % step.size) * UNIT_MS.day;
  }
  // Weeks start on Monday, as Cloud's calendars default to.
  if (step.unit === "week") return Date.UTC(y, m, d) - ((date.getUTCDay() + 6) % 7) * UNIT_MS.day;
  if (step.unit === "month") return Date.UTC(y, Math.floor(m / step.size) * step.size, 1);
  return Date.UTC(y, 0, 1);
};

const nextWall = (wall: number, step: ChartTimeStep): number => {
  const date = new Date(wall);
  if (step.unit === "month") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + step.size, 1);
  if (step.unit === "year") return Date.UTC(date.getUTCFullYear() + step.size, 0, 1);
  return wall + step.size * UNIT_MS[step.unit];
};

/** The round step for a time span: the finest one that keeps at most `maxTicks` ticks. */
export const chartTimeStep = (span: number, maxTicks: number): ChartTimeStep =>
  STEPS.find((step) => span / (step.size * UNIT_MS[step.unit]) <= maxTicks) ?? STEPS.at(-1)!;

/** Tick instants inside `domain` that fall on round wall times of `step` in `timeZone`. */
export const calendarTimeTicks = (
  domain: readonly [number, number],
  timeZone: string,
  step: ChartTimeStep,
  clock: { wallOf: (instant: number, zone: string) => number; instantOf: (wall: number, zone: string) => number },
): number[] => {
  const { wallOf, instantOf } = clock;
  const [lo, hi] = domain;
  const ticks: number[] = [];
  // Instants outside the Date range have no wall time; Bun reads their "NaN-NaN-…" wall as 2000 and counts from there.
  if ([lo, hi].some((instant) => Number.isNaN(new Date(instant).getTime()))) return ticks;
  // A day that a DST change shortens maps a missing wall time onto the next one; it shows once. The budget counts
  // steps, not ticks, so a step that repeats a tick or does not advance ends too.
  for (let wall = floorWall(wallOf(lo, timeZone), step), steps = 0; steps <= 1_000; steps++) {
    const instant = instantOf(wall, timeZone);
    if (instant > hi) break;
    if (instant >= lo && instant !== ticks.at(-1)) ticks.push(instant);
    const next = nextWall(wall, step);
    if (!(next > wall)) break;
    wall = next;
  }
  return ticks;
};

/** Default label of a tick: the clock time, the day at local midnight, the month or the year. */
export const calendarTimeLabel = (tick: number, step: ChartTimeStep, axis: ChartTimeAxis, midnight: boolean): string => {
  const locale = axis.locale ?? "en";
  const options: Intl.DateTimeFormatOptions =
    (step.unit === "minute" || step.unit === "hour") && !midnight
      ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
      : step.unit === "month"
        ? { month: "short", year: "numeric" }
        : step.unit === "year"
          ? { year: "numeric" }
          : { day: "numeric", month: "short" };
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: axis.timeZone }).format(tick);
};
