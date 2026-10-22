export const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

export const isoNullable = (value: Date | string | null): string | null => (value ? iso(value) : null);

export const normalizeDimensions = (dimensions: Record<string, unknown> | undefined): Record<string, string> => {
  const entries = Object.entries(dimensions ?? {})
    .map(([key, value]) => [key.trim(), value] as const)
    .filter(([key, value]) => key.length > 0 && value !== null && value !== undefined)
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
};
