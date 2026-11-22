import type { PublicField as Field } from "../../../api/public-dto";

// One-line values whose control is a 36 px field (K5b): two of them share a row of the record form.
const PAIRED_TYPES = new Set(["text", "number", "percent", "duration", "date", "select", "principal"]);

const paired = (field: Field) =>
  PAIRED_TYPES.has(field.type) && !field.presentable && field.config.multiple !== true && field.config.cardinality !== "multiple";

/**
 * The rows of the record form in field order (K5b, K15): the record's name, long text, links, lists, files, and
 * check boxes take a row of their own; one-line values pair up in a row of two, whose controls share their top edge.
 * A one-line value without a partner before the next wide field keeps its row alone.
 */
export const recordFieldRows = (fields: readonly Field[]): Field[][] => {
  const rows: Field[][] = [];
  let open: Field | null = null;
  for (const field of fields) {
    if (!paired(field)) {
      if (open) rows.push([open]);
      open = null;
      rows.push([field]);
    } else if (open) {
      rows.push([open, field]);
      open = null;
    } else open = field;
  }
  if (open) rows.push([open]);
  return rows;
};
