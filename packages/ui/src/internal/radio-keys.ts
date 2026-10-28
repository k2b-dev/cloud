/**
 * Roving focus for a single-choice radio group: arrows move and select with wrapping, Home and End select the first
 * and last option. Returns the index to select, or `undefined` for keys the group does not handle.
 */
export const radioKeyTarget = (key: string, index: number, count: number): number | undefined => {
  if (count === 0) return undefined;
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
};
