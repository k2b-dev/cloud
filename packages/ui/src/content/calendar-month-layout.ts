/** One entry of a month week row, with its first and last day as `YYYY-MM-DD` keys. */
export type MonthEntry<T> = {
  item: T;
  /** The entry's first day, which may lie before the row. */
  firstKey: string;
  /** The entry's last day, which may lie after the row. */
  lastKey: string;
  /** All-day and multi-day entries are bars that keep a lane; the others stack in their day below the bars. */
  bar: boolean;
};

/** The part of a bar inside one week row, from `startColumn` to `endColumn`, both inclusive. */
export type MonthBar<T> = {
  item: T;
  startColumn: number;
  endColumn: number;
  lane: number;
  /** The entry began before this row: the bar's start is torn. */
  continuesBefore: boolean;
  /** The entry goes on after this row: the bar's end is torn. */
  continuesAfter: boolean;
};

export type MonthWeekLayout<T> = {
  bars: MonthBar<T>[];
  /** Per column, the entries that are not bars, in the order the row lists them. */
  singles: T[][];
};

/**
 * Lays one week row out. Each bar is one piece over the days it covers in the row and keeps one lane on all of them,
 * so a long entry never moves between its days: bars that start earlier come first, a longer bar before a shorter one
 * with the same start, and otherwise the row's own order decides. Every lane is the lowest one free on all its days.
 */
export const layoutMonthWeek = <T>(dayKeys: readonly string[], entries: readonly MonthEntry<T>[]): MonthWeekLayout<T> => {
  const singles: T[][] = dayKeys.map(() => []);
  const first = dayKeys[0];
  const last = dayKeys[dayKeys.length - 1];
  if (!first || !last) return { bars: [], singles };
  // Day keys sort as text, so the first day at or after a key is its column.
  const column = (key: string) => {
    const index = dayKeys.findIndex((dayKey) => dayKey >= key);
    return index < 0 ? dayKeys.length - 1 : index;
  };
  const pieces: Omit<MonthBar<T>, "lane">[] = [];
  for (const entry of entries) {
    if (entry.lastKey < first || entry.firstKey > last || entry.firstKey > entry.lastKey) continue;
    if (!entry.bar) {
      const index = dayKeys.indexOf(entry.firstKey);
      if (index >= 0) singles[index]!.push(entry.item);
      continue;
    }
    pieces.push({
      item: entry.item,
      startColumn: column(entry.firstKey),
      endColumn: entry.lastKey >= last ? dayKeys.length - 1 : column(entry.lastKey),
      continuesBefore: entry.firstKey < first,
      continuesAfter: entry.lastKey > last,
    });
  }
  const ordered = pieces
    .map((piece, order) => ({ piece, order }))
    .sort(
      (left, right) =>
        left.piece.startColumn - right.piece.startColumn ||
        right.piece.endColumn - right.piece.startColumn - (left.piece.endColumn - left.piece.startColumn) ||
        left.order - right.order,
    );
  const lanes: MonthBar<T>[][] = [];
  const bars = ordered.map(({ piece }) => {
    const overlaps = (other: MonthBar<T>) => other.startColumn <= piece.endColumn && other.endColumn >= piece.startColumn;
    let lane = lanes.findIndex((taken) => !taken.some(overlaps));
    if (lane < 0) lane = lanes.push([]) - 1;
    const bar = { ...piece, lane };
    lanes[lane]!.push(bar);
    return bar;
  });
  return { bars, singles };
};

/** What one day cell of a week row draws: its entries from row `top` on, and how many it counts as "+N" below them. */
export type MonthCellFit<T> = {
  /** The first row below the bars drawn over this day. */
  top: number;
  shown: T[];
  hidden: number;
};

export type MonthWeekFit<T> = {
  /** The bars drawn whole; a bar that does not fit on one of its days is counted on each of them instead. */
  bars: MonthBar<T>[];
  cells: MonthCellFit<T>[];
};

/**
 * Fits a week row into cells that have room for `capacity` rows each. A cell whose entries all fit draws them all;
 * otherwise it gives its last row to "+N", which counts every entry of the day that is not drawn, hidden bars included.
 * A bar is drawn only when it fits on every day it covers, so it is never cut off by a count.
 */
export const fitMonthWeek = <T>(layout: MonthWeekLayout<T>, capacity: number): MonthWeekFit<T> => {
  const room = Math.max(0, Math.floor(capacity));
  const limits = layout.singles.map(() => room);
  let bars = layout.bars;
  let cells: MonthCellFit<T>[] = [];
  // Limits only ever drop from the capacity by one, so this settles after at most one pass per day.
  for (let pass = 0; pass <= limits.length; pass++) {
    bars = layout.bars.filter((bar) => {
      for (let day = bar.startColumn; day <= bar.endColumn; day++) if (bar.lane >= (limits[day] ?? 0)) return false;
      return true;
    });
    let changed = false;
    cells = layout.singles.map((singles, day) => {
      const covers = (bar: MonthBar<T>) => bar.startColumn <= day && day <= bar.endColumn;
      const top = bars.reduce((rows, bar) => (covers(bar) ? Math.max(rows, bar.lane + 1) : rows), 0);
      const shown = singles.slice(0, Math.max(0, (limits[day] ?? 0) - top));
      const hiddenBars = layout.bars.filter((bar) => covers(bar) && !bars.includes(bar)).length;
      const hidden = singles.length - shown.length + hiddenBars;
      if (hidden > 0 && limits[day] === room && room > 0) {
        limits[day] = room - 1;
        changed = true;
      }
      return { top, shown, hidden };
    });
    if (!changed) break;
  }
  return { bars, cells };
};

/** How many rows of `lane` height with `gap` between them fit into `height`. */
export const monthLaneCapacity = (height: number, lane: number, gap: number): number =>
  lane > 0 && height > 0 ? Math.max(0, Math.floor((height + gap) / (lane + gap))) : 0;
