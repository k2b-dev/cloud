/**
 * Where a moved row lands, as plain numbers. A "gap" is a place between rendered rows, 0 above the first and `rows`
 * below the last; the rendered rows still include the moved one, which stays in place until it is dropped. An
 * "index" is the row's position after the move, the one `onMove` receives.
 */

/** How far below the pointer the line may sit; the preview hangs further down, so it never covers the line. */
export const LINE_REACH = 8;

/** The gap above the first row that does not end above the pointer (plus the reach). */
export const gapAt = (bottoms: readonly number[], y: number): number => {
  let gap = 0;
  while (gap < bottoms.length && bottoms[gap]! <= y + LINE_REACH) gap++;
  return gap;
};

/** The index a drop into `gap` gives; `from` is the moved row's index in this list, or -1 when it comes from another. */
export const indexForGap = (gap: number, from: number): number => (from >= 0 && gap > from ? gap - 1 : gap);

/** The gap whose line shows `index`; landing where it is shows the line on the moved row's upper edge. */
export const gapForIndex = (index: number, from: number): number => (from >= 0 && index > from ? index + 1 : index);

/** Places in a list of `rows` rows: one more when the moved row comes from another list. */
export const placeCount = (rows: number, own: boolean): number => (own ? rows : rows + 1);

export const clampIndex = (index: number, count: number): number => Math.max(0, Math.min(count - 1, index));
