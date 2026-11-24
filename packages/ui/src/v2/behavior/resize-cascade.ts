/**
 * The push at the minimum for column grips, as plain arithmetic. Its own module without imports, so a test can import
 * it without loading Solid components (`.tsx`), which a browser test process does not compile.
 *
 * The widths after moving the grip right of column `grip` by `delta` px, from `start` (every column, the last
 * included). Columns beyond the grip on the losing side give way nearest first, each down to its minimum.
 */
export const cascade = (start: readonly number[], mins: readonly number[], grip: number, delta: number): number[] => {
  const widths = [...start];
  const loser = delta > 0 ? (index: number) => grip + 1 + index : (index: number) => grip - index;
  const gainer = delta > 0 ? grip : grip + 1;
  let left = Math.abs(delta);
  for (let step = 0; left > 0; step++) {
    const index = loser(step);
    if (index < 0 || index >= widths.length) break;
    const give = Math.min(left, Math.max(0, (widths[index] ?? 0) - (mins[index] ?? 0)));
    widths[index] = (widths[index] ?? 0) - give;
    left -= give;
  }
  widths[gainer] = (widths[gainer] ?? 0) + Math.abs(delta) - left;
  return widths;
};

/** How far grip `grip` can travel each way from `start` before every column on that side is at its minimum. */
export const limits = (start: readonly number[], mins: readonly number[], grip: number): { left: number; right: number } => {
  const room = (from: number, to: number) =>
    start.slice(from, to).reduce((total, width, index) => total + Math.max(0, width - (mins[from + index] ?? 0)), 0);
  return { left: -room(0, grip + 1), right: room(grip + 1, start.length) };
};
