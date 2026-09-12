import Decimal from "decimal.js";
import type { FinancialExportPreview } from "../../../api/workflow-document-confirmations";

/** Sum the full captured batch, never the visible page or binary floats. */
export const financialExportTotals = (preview: FinancialExportPreview) => {
  if (preview.kind === "datev-csv") {
    let debit = new Decimal(0);
    let credit = new Decimal(0);
    for (const row of preview.input.rows) {
      if (row.direction === "S") debit = debit.plus(row.amount);
      else credit = credit.plus(row.amount);
    }
    return [
      { key: "debit" as const, value: debit.toFixed(2) },
      { key: "credit" as const, value: credit.toFixed(2) },
    ];
  }
  return [{ key: "total" as const, value: preview.input.rows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).toFixed(2) }];
};
