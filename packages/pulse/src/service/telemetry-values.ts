import type { PulseCurrentState, PulseRecordedEvent } from "../contracts";

export type RecordedEventRow = {
  id: string;
  kind: string;
  ts: Date | string;
  value: number | null;
  source_id: string | null;
  resource_key: string | null;
  resource_type: string | null;
  dimensions: unknown;
  attributes: unknown;
  payload: unknown;
  recorded_at: Date | string;
};

export type CurrentStateRow = {
  variant_key: string;
  state_key: string;
  value: unknown;
  source_id: string | null;
  resource_key: string | null;
  resource_type: string | null;
  dimensions: unknown;
  updated_at: Date | string;
};

export const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

export const isoNullable = (value: Date | string | null): string | null => (value ? iso(value) : null);

export const readJsonObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a JSON object from Pulse storage");
  }
  return Object.fromEntries(Object.entries(value));
};

export const normalizeDimensions = (dimensions: Record<string, unknown> | undefined): Record<string, string> => {
  const entries = Object.entries(dimensions ?? {})
    .map(([key, value]) => [key.trim(), value] as const)
    .filter(([key, value]) => key.length > 0 && value !== null && value !== undefined)
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
};

export const jsonbObject = (value: Record<string, unknown>): string => JSON.stringify(value);

export const mapRecordedEvent = (row: RecordedEventRow): PulseRecordedEvent => ({
  id: row.id,
  kind: row.kind,
  ts: iso(row.ts),
  value: row.value,
  sourceId: row.source_id,
  resourceKey: row.resource_key,
  resourceType: row.resource_type,
  dimensions: normalizeDimensions(readJsonObject(row.dimensions)),
  attributes: readJsonObject(row.attributes),
  payload: readJsonObject(row.payload),
  recordedAt: iso(row.recorded_at),
});

export const mapCurrentState = (row: CurrentStateRow): PulseCurrentState => ({
  variantKey: row.variant_key,
  key: row.state_key,
  value: row.value,
  sourceId: row.source_id,
  resourceKey: row.resource_key,
  resourceType: row.resource_type,
  dimensions: normalizeDimensions(readJsonObject(row.dimensions)),
  updatedAt: iso(row.updated_at),
});
