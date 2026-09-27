const RANK_STEP = 1024n;

type RankValue = string | number | bigint | null | undefined;

const toBigInt = (value: RankValue): bigint => {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  return BigInt(value);
};

export const rank = {
  step: () => RANK_STEP,
  parse: toBigInt,
  toDb: (value: bigint) => value.toString(),
  atIndex: (index: number) => (BigInt(index) + 1n) * RANK_STEP,
  next: (max: RankValue) => {
    const maxRank = toBigInt(max);
    return maxRank > 0n ? maxRank + RANK_STEP : RANK_STEP;
  },
  /** A rank strictly between two neighbors, one step beyond an open end, or null when no integer fits. */
  between: (before: RankValue, after: RankValue): bigint | null => {
    const prev = before === null || before === undefined ? null : toBigInt(before);
    const next = after === null || after === undefined ? null : toBigInt(after);

    if (prev === null && next === null) return RANK_STEP;
    if (prev === null) return next! - RANK_STEP;
    if (next === null) return prev + RANK_STEP;
    if (next <= prev) return null;

    const gap = next - prev;
    if (gap <= 1n) return null;

    return prev + gap / 2n;
  },
};
