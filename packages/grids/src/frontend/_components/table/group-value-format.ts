import type { DateContext } from "@k2b/stdlib";
import type { PublicField as Field } from "../../../api/public-dto";
import type { AggregationSpec, GroupBySpec } from "../../../contracts";
import { formatFieldValueText } from "./field-value-format";
import { formatCell } from "./format-cell";
import { tableMessages } from "./messages";

const groupFieldForDisplay = (field: Field, spec: GroupBySpec): Field =>
  spec.granularity ? { ...field, config: { ...field.config, includeTime: false } } : field;

export const formatGroupValue = (options: {
  value: unknown;
  spec: GroupBySpec;
  field?: Field;
  relationLabels?: Record<string, string>;
  dateConfig?: DateContext;
  locale?: string;
}): string => {
  const locale = options.locale ?? options.dateConfig?.locale ?? "en";
  if (!options.field) return options.value == null ? tableMessages.resolve([locale]).t.unknown : String(options.value);
  if (options.value === null || options.value === undefined) return "—";
  return (
    formatFieldValueText({
      field: groupFieldForDisplay(options.field, options.spec),
      value: options.value,
      format: options.spec.format,
      relationLabels: options.relationLabels,
      dateConfig: options.dateConfig,
      locale,
    }) || String(options.value)
  );
};

export const formatAggregationValue = (options: {
  value: unknown;
  spec: AggregationSpec;
  field?: Field;
  dateConfig?: DateContext;
  locale?: string;
}): string => {
  const { value, spec } = options;
  const locale = options.locale ?? options.dateConfig?.locale ?? "en";
  if (value === null || value === undefined) return "—";
  if (spec.format) {
    if (options.field) {
      return (
        formatFieldValueText({ field: options.field, value, format: spec.format, dateConfig: options.dateConfig, locale }) || String(value)
      );
    }
    return formatCell(value, "number", {}, spec.format, options.dateConfig, locale) || String(value);
  }
  if (typeof value === "number") {
    return new Intl.NumberFormat(locale, {
      useGrouping: false,
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    }).format(value);
  }
  return String(value);
};
