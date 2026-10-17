import type { CloudAiChartTable } from "@k2b/cloud/ai/browser";

// A formatted number such as `-1.200,00 €`, `-$18.00` or `-5 %`: a spreadsheet reads it as a value.
const plainNumber = /^[-+]?\p{Sc}?\s?\d[\d.,\s]*(?:\s?(?:%|\p{Sc}))?$/u;

/**
 * Spreadsheets run a pasted cell that starts like a formula. A leading apostrophe keeps it as text, unless the cell is
 * only a formatted number: a unit or compact suffix such as `-1 +1` would still run.
 */
const tsvCell = (value: string) => {
  const safe = /^[=+\-@\t\r]/.test(value) && !plainNumber.test(value) ? `'${value}` : value;
  return /[\t\r\n"]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** A chart's table as tab-separated text with the shown, formatted cells, as Copy data puts it on the clipboard. */
export const chartTableText = (table: CloudAiChartTable): string =>
  [
    table.columns.map((column) => tsvCell(column.label)).join("\t"),
    ...table.rows.map((row) => table.columns.map((column) => tsvCell(row.cells[column.id] ?? "")).join("\t")),
  ].join("\n");
