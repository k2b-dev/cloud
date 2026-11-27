import { CHANGE_DAYS, type StorageChangeSeries } from "../contracts";

const DAY_MS = 86_400_000;
const dayKey = (time: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(time);

/**
 * The reader's last `CHANGE_DAYS` days as `YYYY-MM-DD`, the oldest first and the last today in `timeZone`. Days are
 * counted on the calendar, so a change of the clock in between neither repeats nor skips one.
 */
export function changeDays(now: Date, timeZone: string): string[] {
  const today = dayKey(now, timeZone);
  // noon UTC of the reader's today: stepping back whole days stays on the same calendar date in every zone
  const noon = Date.parse(`${today}T12:00:00.000Z`);
  return Array.from({ length: CHANGE_DAYS }, (_, index) => new Date(noon - (CHANGE_DAYS - 1 - index) * DAY_MS).toISOString().slice(0, 10));
}

/**
 * The series from the grouped read: a row per storage and day, and `baseId: null` for the total over all storages
 * (which the read counts itself, so a change between two storages counts once). A day outside `days` is left out, and
 * a storage without a row on one of them has no series.
 */
export function dailySeries(
  days: readonly string[],
  rows: readonly { baseId: string | null; day: string; changes: number }[],
): StorageChangeSeries {
  const position = new Map(days.map((day, index) => [day, index]));
  const total = days.map(() => 0);
  const storages = new Map<string, number[]>();
  for (const row of rows) {
    const index = position.get(row.day);
    if (index === undefined) continue;
    let series = total;
    if (row.baseId !== null) {
      series = storages.get(row.baseId) ?? days.map(() => 0);
      storages.set(row.baseId, series);
    }
    series[index] = row.changes;
  }
  return { from: days[0]!, total, storages: [...storages].map(([baseId, values]) => ({ baseId, days: values })) };
}
