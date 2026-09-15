import type { BillingText } from "./billing";
import { field, formula, type GridTemplate, table, view } from "./types";

/** Live balances do not modify or recapture finalized invoice amounts. */
export const billingBalanceSource = (t: BillingText, oneRecord = false) =>
  formula(
    "from table ",
    table("bills"),
    " as bill\nleft join view ",
    view("payment_totals"),
    " as payments_summary on payments_summary.gk_0 = bill.id\nleft join view ",
    view("correction_totals"),
    " as credited on credited.gk_0 = bill.id\nselect ",
    field("bills.reference"),
    ", ",
    field("bills.party_name"),
    ", ",
    field("bills.kind"),
    ", ",
    field("bills.gross"),
    `, formula(IF(ISBLANK(payments_summary.summed_amount), 0, payments_summary.summed_amount)) as ${t.paid}, formula(IF(ISBLANK(credited.summed_amount), 0, credited.summed_amount)) as ${t.corrected}, formula(IF(`,
    field("bills.kind"),
    " = 'creditNote', 0, ",
    field("bills.gross"),
    ` - IF(ISBLANK(payments_summary.summed_amount), 0, payments_summary.summed_amount) - IF(ISBLANK(credited.summed_amount), 0, credited.summed_amount))) as ${t.outstanding}`,
    "\nwhere record.finalizationState = 'finalized'",
    oneRecord ? " and record.id = @params.bill_id" : "",
    "\nsort record.createdAt desc",
  );

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
