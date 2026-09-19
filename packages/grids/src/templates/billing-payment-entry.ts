import type { BillingText } from "./billing";
import type { GridTemplate } from "./types";

/** Manual entry records the actual money movement in one guarded transaction. */
export const billingPaymentEntryWorkflows = (t: BillingText, gross: string): NonNullable<GridTemplate["workflows"]> => {
  const q = JSON.stringify;
  return [
    { key: "record_payment", name: t.paymentForm, kind: "invoice", refund: false },
    { key: "record_refund", name: t.refundForm, kind: "invoice", refund: true },
    { key: "record_payout", name: t.payoutForm, kind: "selfBilling", refund: false },
  ].map(({ key, name, kind, refund }) => ({
    key,
    name,
    enabled: true,
    source: `inputs:
  bill: {type: record, table: ${q(t.bills)}, required: true}
  date: {type: date, label: ${q(t.date)}, required: true}
  amount: {type: decimal, label: ${q(t.amount)}, required: true, description: ${q(t.paymentAmountHelp)}}
  reference: {type: text, label: ${q(t.reference)}, required: false}
steps:
  - atomicRecords:
      locks: [inputs.bill]
      checks:
        - query:
            source: |
              from table ${q(t.bills)} as bill
              left join view ${q(t.paymentTotals)} as paid on paid.gk_0 = bill.id
              left join view ${q(t.correctionTotals)} as credited on credited.gk_0 = bill.id
              select ${q(t.reference)}
              where record.id = @params.bill and record.finalizationState = 'finalized' and ${q(t.kind)} = '${kind}' and @params.amount > 0${refund ? ` and IF(ISBLANK(paid.summed_amount), 0, paid.summed_amount) + IF(ISBLANK(credited.summed_amount), 0, credited.summed_amount) - ${q(gross)} >= @params.amount` : ""}
              limit 1
            parameters:
              bill: {type: record, value: "\${{ inputs.bill }}"}
              amount: {type: decimal, value: "\${{ inputs.amount }}"}
          assert: notEmpty
          message: ${q(refund ? t.refundError : t.paymentError)}
      changes:
        - createRecord:
            table: ${q(t.payments)}
            finalize: true
            values:
              ${q(t.bills)}: "\${{ inputs.bill.recordId }}"
              ${q(t.date)}: "\${{ inputs.date }}"
              ${q(t.amount)}: "\${{ inputs.amount }}"
              ${q(t.reference)}: "\${{ inputs.reference }}"
              ${q(t.refund)}: ${refund}
`,
  }));
};
