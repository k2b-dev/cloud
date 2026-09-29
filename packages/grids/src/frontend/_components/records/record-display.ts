import type { DateContext } from "@k2b/stdlib";
import type { PublicField as Field, PublicGridRecord as GridRecord } from "../../../api/public-dto";
import type { ColumnSpec, FormatSpec } from "../../../contracts";
import { fieldDisplayFormat, formatFieldValueText } from "../table/field-value-format";

export const recordTitleField = (fields: Field[]): Field | undefined => {
  const visible = fields.filter((field) => !field.deletedAt);
  return (
    visible.find((field) => field.presentable && !["longtext", "html_template", "json", "file", "relation"].includes(field.type)) ??
    visible.find((field) => field.type === "text")
  );
};

export const fieldDisplayFormatForView = (field: Field, viewColumns?: ColumnSpec[]): FormatSpec | undefined => {
  const column = viewColumns?.find((item) => !("kind" in item) && item.fieldId === field.id);
  return fieldDisplayFormat(field, column?.format);
};

export const recordDisplayTitle = (input: {
  fields: Field[];
  record: GridRecord;
  fieldsByTable?: Record<string, Field[]>;
  relationLabels?: Record<string, string>;
  dateConfig?: DateContext;
  viewColumns?: ColumnSpec[];
}): string => {
  const titleField = recordTitleField(input.fields);
  if (titleField) {
    const formatted = formatFieldValueText({
      field: titleField,
      value: input.record.data[titleField.id],
      fieldsByTable: input.fieldsByTable,
      relationLabels: input.relationLabels,
      dateConfig: input.dateConfig,
      format: fieldDisplayFormatForView(titleField, input.viewColumns),
    }).trim();
    if (formatted) return formatted;
  }
  return input.record.id.slice(0, 8);
};
