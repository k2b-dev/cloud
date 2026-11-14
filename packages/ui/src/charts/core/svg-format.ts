export const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return "0";
  // 2 decimals is enough for sub-pixel precision at typical sizes.
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}` : `${rounded}`;
};
