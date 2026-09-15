import type { BillingText } from "./billing";
import { billingIssueOrRetrieveSource } from "./billing-issuance";
import { billingAmountFields } from "./billing-lines";
import { billingSettlementWorkflow } from "./billing-settlement";
import type { GridTemplate } from "./types";

const paymentConfirmation = (t: BillingText, withReference: boolean, gross: string) => {
  const q = JSON.stringify;
  return `  - atomicRecords:
      locks: [inputs.payment, ${q(`inputs.payment.${t.bills}`)}]
      checks:
        - query:
            source: |
              from table ${q(t.bills)} as bill
              left join view ${q(t.paymentTotals)} as paid on paid.gk_0 = bill.id
              left join view ${q(t.correctionTotals)} as credited on credited.gk_0 = bill.id
              select ${q(t.reference)}
              where record.id = @params.bill and record.finalizationState = 'finalized' and ((@params.refund = false and ${q(t.kind)} != 'creditNote') or (@params.refund = true and ${q(t.kind)} = 'invoice' and IF(ISBLANK(paid.summed_amount), 0, paid.summed_amount) + IF(ISBLANK(credited.summed_amount), 0, credited.summed_amount) - ${q(gross)} >= @params.amount))
              limit 1
            parameters:
              bill: {type: record, value: "\${{ inputs.payment.${t.bills} }}"}
              refund: {type: boolean, value: "\${{ inputs.payment.${t.refund} }}"}
              amount: {type: decimal, value: "\${{ inputs.payment.${t.amount} }}"}
          assert: notEmpty
          message: ${q(t.refundError)}
        - query:
            source: |
              from table ${q(t.payments)}
              select ${q(t.amount)}
              where record.id = @params.payment and record.finalizationState = 'draft' and ${q(t.bills)} = @params.bill and ${q(t.amount)} = @params.amount and ${q(t.date)} = @params.date and ${q(t.refund)} = @params.refund and ${q(t.reference)} = ${withReference ? "@params.reference" : "null"}
              limit 1
            parameters:
              payment: {type: record, value: "\${{ inputs.payment }}"}
              bill: {type: record, value: "\${{ inputs.payment.${t.bills} }}"}
              amount: {type: decimal, value: "\${{ inputs.payment.${t.amount} }}"}
              date: {type: date, value: "\${{ inputs.payment.${t.date} }}"}
              refund: {type: boolean, value: "\${{ inputs.payment.${t.refund} }}"}
${withReference ? `              reference: {type: text, value: "\${{ inputs.payment.${t.reference} }}"}\n` : ""}          assert: notEmpty
          message: ${q(t.paymentError)}
      changes:
        - finalizeRecord: {record: inputs.payment}`
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
};

export const billingWorkflows = (t: BillingText, locale?: string): NonNullable<GridTemplate["workflows"]> => {
  const q = JSON.stringify;
  const amountFields = billingAmountFields("bills", locale);
  const name = (key: string) => q(amountFields.find((entry) => entry.key === key)!.name);
  const budgetChecks = ["net7", "net19"]
    .map((key) => {
      const rate = key === "net7" ? "0.07" : "0.19";
      // The original is finalized before this action: its exact frozen cap is
      // safe to pass as a value. Only competing credits need a current SQL read.
      return `        - query:
            source: |
              from table ${q(t.bills)}
              where ${q(t.original)} = @params.original and ${q(t.kind)} = 'creditNote' and (record.id = @params.bill or record.finalizationState = 'finalized')
              group by ${q(t.original)}
              aggregate sum(${name(key)}) as used_net, sum(formula(ROUND(${name(key)} * ${rate}, 2))) as used_tax
              having used_net <= @params.cap and used_tax <= ROUND(@params.cap * ${rate}, 2) and used_tax + ROUND((@params.cap - used_net) * ${rate}, 2) = ROUND(@params.cap * ${rate}, 2)
            parameters:
              bill: {type: record, value: "\${{ inputs.bill }}"}
              original: {type: record, value: "\${{ original }}"}
              cap: {type: decimal, value: "\${{ original.${amountFields.find((entry) => entry.key === key)!.name} }}"}
          assert: notEmpty
          message: ${q(t.correctionRoundingError)}
`;
    })
    .join("");
  const inputs = `inputs:
  bill:
    type: record
    table: ${q(t.bills)}
    required: true
`;
  return [
    {
      key: "issue_invoice",
      name: t.issue,
      enabled: true,
      source: billingIssueOrRetrieveSource(
        t,
        `  - atomicRecords:
      locks:
        - inputs.bill
        - inputs.bill.${t.settings}
        - inputs.bill.${t.party}
      checks:
        - query:
            source: |
              from table ${q(t.settings)}
              select ${q(t.setupKey)}
              where record.id = @params.settings and ${q(t.setupKey)} = 'issuer' and ${q(t.ready)} = true
              limit 1
            parameters:
              settings: {type: record, value: "\${{ inputs.bill.${t.settings} }}"}
          assert: notEmpty
          message: ${q(t.issueError)}
        - query:
            source: |
              from table ${q(t.bills)}
              select ${q(t.reference)}
              where record.id = @params.bill and record.finalizationState = 'draft' and ${q(t.kind)} = 'invoice' and ${q(t.settings)} = @params.settings and ${q(t.party)} = @params.party
              limit 1
            parameters:
              bill: {type: record, value: "\${{ inputs.bill }}"}
              settings: {type: record, value: "\${{ inputs.bill.${t.settings} }}"}
              party: {type: record, value: "\${{ inputs.bill.${t.party} }}"}
          assert: notEmpty
          message: ${q(t.issueError)}
      changes:
        - finalizeRecord: {record: inputs.bill}
      validateDocuments:
        - template: ${q(t.documents)}
          record: inputs.bill
`,
      ),
    },
    {
      key: "new_correction",
      name: t.newCorrection,
      enabled: true,
      source: `${inputs}steps:
  - if:
      notEquals: ["\${{ inputs.bill.${t.kind} }}", [invoice]]
    then:
      - fail: {message: ${q(t.correctionError)}}
  - generateDocument:
      template: ${q(t.documents)}
      record: inputs.bill
      saveAs: originalDocument
  - createCorrectionDraft:
      original: inputs.bill
      typeField: ${q(t.kind)}
      typeValue: creditNote
      originalField: ${q(t.original)}
      copyFields: [${name("positions")}, ${q(t.serviceDate)}, ${q(t.buyerReference)}, ${q(t.note)}]
      values:
        ${q(t.settings)}: "\${{ inputs.bill.${t.settings}.recordId }}"
        ${q(t.party)}: "\${{ inputs.bill.${t.party}.recordId }}"
        ${q(`${t.original}: ${t.reference}`)}: "\${{ originalDocument.number }}"
        ${q(`${t.original}: ${t.invoiceDate}`)}: "\${{ inputs.bill.${t.invoiceDate} }}"
      saveAs: correction
`,
    },
    {
      key: "issue_correction",
      name: t.issueCorrection,
      enabled: true,
      source: billingIssueOrRetrieveSource(
        t,
        `  - setVariable:
      name: original
      value: "\${{ inputs.bill.${t.original} }}"
  - if:
      notEquals: ["\${{ original.${t.kind} }}", [invoice]]
    then:
      - fail: {message: ${q(t.correctionError)}}
  - generateDocument:
      template: ${q(t.documents)}
      record: original
      saveAs: originalDocument
  - atomicRecords:
      locks: [inputs.bill, original, "inputs.bill.${t.settings}", "inputs.bill.${t.party}"]
      checks:
        - query:
            source: |
              from table ${q(t.settings)}
              select ${q(t.setupKey)}
              where record.id = @params.settings and ${q(t.setupKey)} = 'issuer' and ${q(t.ready)} = true
              limit 1
            parameters:
              settings: {type: record, value: "\${{ inputs.bill.${t.settings} }}"}
          assert: notEmpty
          message: ${q(t.issueError)}
        - query:
            source: |
              from table ${q(t.bills)}
              select ${q(t.reference)}
              where record.id = @params.bill and record.finalizationState = 'draft' and ${q(t.kind)} = 'creditNote' and ${q(t.original)} = @params.original and ${q(t.settings)} = @params.settings and ${q(t.party)} = @params.party
              limit 1
            parameters:
              bill: {type: record, value: "\${{ inputs.bill }}"}
              original: {type: record, value: "\${{ original }}"}
              settings: {type: record, value: "\${{ inputs.bill.${t.settings} }}"}
              party: {type: record, value: "\${{ inputs.bill.${t.party} }}"}
          assert: notEmpty
          message: ${q(t.correctionError)}
        - query:
            source: |
              from table ${q(t.bills)}
              select ${q(t.reference)}
              where record.id = @params.original and record.finalizationState = 'finalized' and ${q(t.kind)} = 'invoice' and ${q(t.settings)} = @params.settings and ${q(t.party)} = @params.party
              limit 1
            parameters:
              original: {type: record, value: "\${{ original }}"}
              settings: {type: record, value: "\${{ inputs.bill.${t.settings} }}"}
              party: {type: record, value: "\${{ inputs.bill.${t.party} }}"}
          assert: notEmpty
          message: ${q(t.correctionError)}
        - query:
            source: |
              from table ${q(t.parties)}
              select ${q(t.iban)}
              where record.id = @params.party and ${q(t.iban)} != null and ${q(t.accountName)} != null
              limit 1
            parameters:
              party: {type: record, value: "\${{ inputs.bill.${t.party} }}"}
          assert: notEmpty
          message: ${q(t.refundBankError)}
${budgetChecks}\
      changes:
        - updateRecord:
            record: inputs.bill
            set:
              ${q(`${t.original}: ${t.reference}`)}: "\${{ originalDocument.number }}"
              ${q(`${t.original}: ${t.invoiceDate}`)}: "\${{ original.${t.invoiceDate} }}"
        - finalizeRecord: {record: inputs.bill}
      validateDocuments:
        - template: ${q(t.documents)}
          record: inputs.bill
`,
      ),
    },
    {
      key: "confirm_payment",
      name: t.confirmPayment,
      enabled: true,
      source: `inputs:
  payment: {type: record, table: ${q(t.payments)}, required: true}
steps:
  - if:
      equals: ["\${{ inputs.payment.${t.reference} }}", null]
    then:
${paymentConfirmation(t, false, amountFields.find((entry) => entry.key === "gross")!.name)}
    else:
${paymentConfirmation(t, true, amountFields.find((entry) => entry.key === "gross")!.name)}
`,
    },
    {
      key: "discard_draft",
      name: t.discardDraft,
      enabled: true,
      source: `${inputs}steps:
  - deleteRecord: {record: inputs.bill}
`,
    },
    {
      key: "discard_payment",
      name: t.discardPayment,
      enabled: true,
      source: `inputs:\n  payment: {type: record, table: ${q(t.payments)}, required: true}\nsteps:\n  - deleteRecord: {record: inputs.payment}\n`,
    },
    billingSettlementWorkflow(t),
  ];
};
