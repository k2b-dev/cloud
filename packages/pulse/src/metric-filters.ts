import { z } from "zod";
import {
  PULSE_METRIC_FILTER_MAX_LENGTH,
  PULSE_METRIC_FILTER_PATTERN,
  PULSE_METRIC_FILTERS_MAX,
  PULSE_SOURCE_CONFIG_MAX_BYTES,
} from "./ingest-limits";

export const MetricFiltersSchema = z
  .array(z.string().min(1).max(PULSE_METRIC_FILTER_MAX_LENGTH).regex(PULSE_METRIC_FILTER_PATTERN))
  .max(PULSE_METRIC_FILTERS_MAX);
export const SourceConfigSchema = z
  .object({ metricFilters: MetricFiltersSchema.optional() })
  .passthrough()
  .refine((config) => new TextEncoder().encode(JSON.stringify(config)).byteLength <= PULSE_SOURCE_CONFIG_MAX_BYTES, {
    message: "Source config exceeds 16 KiB",
  });
export const parseMetricFilterInput = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
export const metricFamilyIncluded = (family: string, filters: readonly string[]): boolean =>
  !filters.length || filters.some((filter) => (filter.endsWith("*") ? family.startsWith(filter.slice(0, -1)) : family === filter));
