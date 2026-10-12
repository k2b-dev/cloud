/**
 * Scroll rules of the continuous month view, free of the DOM so they can be tested.
 *
 * Uniform week rows run below a sticky weekday header without stops. The center row names the month, and rows
 * visible by more than half supply the host's dates. Calendar day keys keep week arithmetic independent of DST.
 */
import { addDayKeys, dayKeyNumber } from "./calendar-days";
import type { TodayDirection } from "./calendar-time-view";

export const MONTH_ROWS_IN_VIEW = 5;
export const MONTH_ROW_BLOCK = 8;

/** Whole weeks covering the loaded days, with an exclusive end and the date context's first weekday. */
export const monthWeekKeys = (first: string, to: string, firstDayOfWeek: 0 | 1): string[] => {
  if (first >= to) return [];
  const weekday = (((dayKeyNumber(first) + 4) % 7) + 7) % 7;
  const start = addDayKeys(first, -((weekday - firstDayOfWeek + 7) % 7));
  const count = Math.ceil((dayKeyNumber(to) - dayKeyNumber(start)) / 7);
  return Array.from({ length: count }, (_, index) => addDayKeys(start, index * 7));
};

/** The row at the center of the area below the weekday header, clamped to the loaded weeks. */
export const monthFocusRow = (top: number, viewHeight: number, rowHeight: number, total: number): number =>
  Math.max(0, Math.min(total - 1, rowHeight > 0 ? Math.floor((top + viewHeight / 2) / rowHeight) : 0));

/** The middle day of a week names its month: Thursday for Monday weeks, Wednesday for Sunday weeks. */
export const monthOfWeek = (week: string): string => `${addDayKeys(week, 3).slice(0, 7)}-01`;

/** The loaded row containing a day, including the first of a month; absent outside the loaded weeks. */
export const monthRowOf = (weeks: readonly string[], key: string): number | undefined => {
  if (!weeks.length) return undefined;
  const row = Math.floor((dayKeyNumber(key) - dayKeyNumber(weeks[0]!)) / 7);
  return row >= 0 && row < weeks.length ? row : undefined;
};

/** The half-open interval of rows whose visible height exceeds half a row. */
export const monthVisibleRows = (top: number, viewHeight: number, rowHeight: number, total: number): { first: number; end: number } => {
  if (rowHeight <= 0 || total === 0) return { first: 0, end: 0 };
  const first = Math.max(0, Math.min(total, Math.floor(top / rowHeight + 0.5)));
  const end = Math.max(first, Math.min(total, Math.ceil((top + viewHeight) / rowHeight - 0.5)));
  return { first, end };
};

/** One block above and below the visible rows' blocks; the window changes only at their block boundaries. */
export const monthRenderWindow = (top: number, viewHeight: number, rowHeight: number, total: number): { first: number; end: number } => {
  if (rowHeight <= 0 || total === 0) return { first: 0, end: 0 };
  const { first, end } = monthVisibleRows(top, viewHeight, rowHeight, total);
  const last = Math.max(first, end - 1);
  return {
    first: Math.max(0, (Math.floor(first / MONTH_ROW_BLOCK) - 1) * MONTH_ROW_BLOCK),
    end: Math.min(total, (Math.floor(last / MONTH_ROW_BLOCK) + 2) * MONTH_ROW_BLOCK),
  };
};

/** The least movement that shows a row whole, or nothing when it is already fully in view. */
export const monthRevealTop = (row: number, top: number, viewHeight: number, rowHeight: number): number | undefined => {
  const start = row * rowHeight;
  if (start < top) return start;
  if (start + rowHeight > top + viewHeight) return Math.max(0, start + rowHeight - viewHeight);
  return undefined;
};

/** Today points up or down until more than half its row is visible. */
export const monthTodayDirection = (row: number, top: number, viewHeight: number, rowHeight: number): TodayDirection => {
  const start = row * rowHeight;
  const visible = Math.min(start + rowHeight, top + viewHeight) - Math.max(start, top);
  return visible > rowHeight / 2 ? "" : start < top ? "up" : "down";
};
