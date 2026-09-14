const MAX_DURATION_MS = 90 * 24 * 60 * 60_000;

export const intervalToMs = (input: string): number | null => {
  const match = input.trim().match(/^(\d+)(m|h|d)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const duration = unit === "m" ? amount * 60_000 : unit === "h" ? amount * 60 * 60_000 : amount * 24 * 60 * 60_000;
  return duration <= MAX_DURATION_MS ? duration : null;
};
