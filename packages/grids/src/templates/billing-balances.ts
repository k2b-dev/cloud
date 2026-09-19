import type { BillingText } from "./billing";
import { field, formula, type GridTemplate, table, view } from "./types";

/** Live balances do not modify or recapture finalized invoice amounts. */
export const billingBalanceSource = (
  t: BillingText,
  oneRecord = false,
  options: {
    metrics?: "outstanding" | "credit";
    group?: "overdue" | "upcoming" | "credits" | "open" | "settled" | "nonpositive";
    invoiceOnly?: boolean;
  } = {},
) => {
  const paid = "IF(ISBLANK(payments_summary.summed_amount), 0, payments_summary.summed_amount)";
  const corrected = "IF(ISBLANK(credited.summed_amount), 0, credited.summed_amount)";
  const outstanding = ["IF(", field("bills.kind"), " = 'creditNote', 0, ", field("bills.gross"), ` - ${paid} - ${corrected})`];
  return formula(
    "from table ",
    table("bills"),
    " as bill\nleft join view ",
    view("payment_totals"),
    " as payments_summary on payments_summary.gk_0 = bill.id\nleft join view ",
    view("correction_totals"),
    " as credited on credited.gk_0 = bill.id\nselect ",
    ...(options.metrics ? [] : [field("bills.party_name"), ", ", field("bills.kind"), ", ", field("bills.due_date"), ", "]),
    ...(options.group || options.metrics
      ? []
      : [field("bills.gross"), `, formula(${paid}) as ${t.paid}, formula(${corrected}) as ${t.corrected}, `]),
    "formula(",
    ...(options.metrics === "credit" ? ["0 - ("] : []),
    ...outstanding,
    ...(options.metrics === "credit" ? [")"] : []),
    `) as ${options.metrics === "credit" ? t.creditBalance : t.outstanding}`,
    "\nwhere record.finalizationState = 'finalized'",
    oneRecord ? " and record.id = @params.bill_id" : "",
    ...(options.invoiceOnly ? [" and ", field("bills.kind"), " = 'invoice'"] : []),
    ...(options.group
      ? [
          " and ",
          field("bills.kind"),
          " != 'creditNote' and ",
          ...outstanding,
          options.group === "credits" ? " < 0" : options.group === "settled" ? " = 0" : options.group === "nonpositive" ? " <= 0" : " > 0",
          ...(options.group === "overdue" || options.group === "upcoming"
            ? [" and ", field("bills.due_date"), options.group === "overdue" ? " < TODAY()" : " >= TODAY()"]
            : []),
        ]
      : []),
    ...(oneRecord ? ["\nlimit 1"] : ["\nsort ", field("bills.due_date"), " asc, record.createdAt desc"]),
  );
};

export const billingBalanceViews = (t: BillingText): NonNullable<GridTemplate["views"]> => [
  {
    key: "payment_totals",
    table: "payments",
    name: t.paymentTotals,
    source: formula(
      "from table ",
      table("payments"),
      "\nwhere record.finalizationState = 'finalized'\ngroup by ",
      field("payments.bill"),
      "\naggregate sum(",
      field("payments.balance_amount"),
      ") as summed_amount",
    ),
  },
  {
    key: "correction_totals",
    table: "bills",
    name: t.correctionTotals,
    source: formula(
      "from table ",
      table("bills"),
      "\nwhere ",
      field("bills.kind"),
      " = 'creditNote' and record.finalizationState = 'finalized'\ngroup by ",
      field("bills.original"),
      "\naggregate sum(",
      field("bills.gross"),
      ") as summed_amount",
    ),
  },
  { key: "balances", table: "bills", name: t.balances, source: billingBalanceSource(t) },
];
