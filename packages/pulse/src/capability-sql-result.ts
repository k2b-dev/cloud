import { CAPABILITY_MAX_RESULT_BYTES } from "@k2b/cloud/contracts";
import type { SqlResult } from "./service/sql-service";

/** Leave 16 KiB for the platform envelope, links, and translated summary. */
const BUDGET = CAPABILITY_MAX_RESULT_BYTES - 16 * 1024;
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Numeric cells are chart points. Rows remain whole, including their labels and timestamps. */
export const boundSqlCapabilityResult = (result: SqlResult, locale: string) => {
  const rows: unknown[][] = [];
  let points = 0;
  const note = locale.toLowerCase().startsWith("de") ? "Ergebnis gekürzt." : "Result truncated.";
  const data: SqlResult & { note?: string } = { ...result, rows, rowCount: 0, truncated: result.truncated };
  for (const row of result.rows) {
    // ClickHouse JSON encodes Int64/UInt64/Decimal values as strings. Their
    // numeric column type still makes each value a chart point.
    const rowPoints = row.filter(
      (value, index) =>
        value !== null &&
        (typeof value === "number" ||
          /(?:^|\()(?:U?Int\d+|Float\d+|BFloat16|Decimal(?:32|64|128|256)?)(?:\b|\()/.test(result.columns[index]?.type ?? "")),
    ).length;
    if (rows.length >= 100 || points + rowPoints > 500) break;
    rows.push(row);
    data.rowCount = rows.length;
    if (byteLength({ ...data, truncated: true, note }) > BUDGET) {
      rows.pop();
      data.rowCount = rows.length;
      break;
    }
    points += rowPoints;
  }
  data.truncated ||= rows.length < result.rows.length;
  if (data.truncated) data.note = note;
  // Metadata alone may exceed the transport budget (for example, huge aliases).
  // Omitting columns is only coherent with an empty table.
  if (byteLength(data) > BUDGET) {
    data.columns = [];
    data.rows = [];
    data.rowCount = 0;
    data.truncated = true;
    data.note = note;
  }
  return data;
};
