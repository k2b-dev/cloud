import type { PublicField as Field } from "../api/public-dto";
import type { AggregationSpec, DslQueryPreviewColumn, DslQueryPreviewResponse, GroupBySpec } from "../contracts";
import { customAppAggregateOutputKey } from "../custom-apps/aggregate-output";
import type { CustomAppValueFormat } from "../custom-apps/contracts";

type PreviewSuccess = Extract<DslQueryPreviewResponse, { ok: true }>;

export type CustomAppChartData =
  | {
      kind: "chart";
      buckets: Array<{ keys: unknown[]; values: Record<string, unknown> }>;
      fields: Field[];
      viewQuery: { groupBy: GroupBySpec[]; aggregations: AggregationSpec[] };
      relationLabels: Record<string, string>;
    }
  | { kind: "error"; reason: string };

export type CustomAppMetricCell = {
  label: string;
  value: unknown;
  valueFormat?: CustomAppValueFormat;
};

const asAggregateKind = (value: string | undefined): AggregationSpec["agg"] | null =>
  value === "count" ||
  value === "countEmpty" ||
  value === "countUnique" ||
  value === "sum" ||
  value === "avg" ||
  value === "min" ||
  value === "max" ||
  value === "median" ||
  value === "earliest" ||
  value === "latest"
    ? value
    : null;

const inferAggKind = (key: string): AggregationSpec["agg"] => asAggregateKind(key.split("__").pop()) ?? "count";

const aggregateKindForColumn = (column: DslQueryPreviewColumn): AggregationSpec["agg"] =>
  asAggregateKind(column.aggregate) ?? inferAggKind(column.key);

const previewChartShape = (preview: PreviewSuccess) => {
  const groupColumns = preview.columns.filter((column) => column.type !== "aggregate");
  const aggregateColumns = preview.columns.filter((column) => column.type === "aggregate");
  const aggregations = aggregateColumns.map((column) => ({
    fieldId: column.key,
    agg: aggregateKindForColumn(column),
    label: column.label,
  }));
  return {
    groupBy: groupColumns.map((column) => ({
      fieldId: column.fieldId ?? column.key,
      label: column.label,
      // SQL date results represent calendar days, including truncated date groups.
      // Preserve that type for the chart's existing locale-aware date formatter.
      ...(column.sqlType === "date" ? { granularity: "day" as const } : {}),
    })),
    aggregations,
    buckets: preview.rows.map((row) => ({
      keys: groupColumns.map((column) => row.values[column.key] ?? null),
      values: Object.fromEntries(
        aggregateColumns.flatMap((column, index) => {
          const spec = aggregations[index];
          return spec ? [[customAppAggregateOutputKey(spec.fieldId, spec.agg), row.values[column.key] ?? null]] : [];
        }),
      ),
    })),
  };
};

export const chartDataFromPreview = (preview: PreviewSuccess, sourceFields: Field[]): CustomAppChartData => {
  const shape = previewChartShape(preview);
  if (shape.groupBy.length === 0 || shape.aggregations.length === 0) {
    return { kind: "error", reason: "chart source must group rows and include at least one aggregation" };
  }
  return {
    kind: "chart",
    ...shape,
    fields: sourceFields,
    viewQuery: { groupBy: shape.groupBy, aggregations: shape.aggregations },
    relationLabels: {},
  };
};

const valueFormatForField = (field: Field): CustomAppValueFormat | undefined => {
  if (field.type === "percent") {
    const config = field.config as { decimals?: number; range?: "percent" | "fraction" };
    return config.range === "fraction"
      ? { style: "percent", decimalPlaces: config.decimals }
      : { style: "number", decimalPlaces: config.decimals, unit: "%", unitPosition: "suffix" };
  }
  if (field.type !== "number") return undefined;
  const config = field.config as {
    decimalPlaces?: number;
    integerOnly?: boolean;
    unit?: string;
    unitPosition?: "prefix" | "suffix";
  };
  return {
    style: config.integerOnly ? "integer" : "number",
    ...(config.integerOnly || config.decimalPlaces === undefined ? {} : { decimalPlaces: config.decimalPlaces }),
    ...(!config.integerOnly && config.unit ? { unit: config.unit, unitPosition: config.unitPosition ?? "suffix" } : {}),
  };
};

const inferValueFormatFromAgg = (agg: string, field: Field | null): CustomAppValueFormat | undefined => {
  if (agg === "count" || agg === "countEmpty" || agg === "countUnique") return { style: "integer" };
  return field ? valueFormatForField(field) : undefined;
};

export const metricCellsFromPreview = (
  preview: PreviewSuccess,
  sourceFields: Field[],
  valueFormat?: CustomAppValueFormat,
): CustomAppMetricCell[] => {
  const row = preview.rows[0];
  if (!row) return [];
  const fieldsById = new Map(sourceFields.map((field) => [field.id, field]));
  return preview.columns.map((column) => {
    const field = column.fieldId ? (fieldsById.get(column.fieldId) ?? null) : null;
    return {
      label: column.label,
      value: row.values[column.key] ?? null,
      valueFormat:
        valueFormat ??
        (column.type === "aggregate"
          ? inferValueFormatFromAgg(aggregateKindForColumn(column), field)
          : field
            ? valueFormatForField(field)
            : undefined),
    };
  });
};
