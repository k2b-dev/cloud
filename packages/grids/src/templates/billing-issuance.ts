import type { BillingText } from "./billing";

/** One stable action owns issuance and retrieval; eligibility survives finalization. */
export const billingIssueOrRetrieveSource = (t: BillingText, draftSteps: string): string => {
  const q = JSON.stringify;
  return `inputs:
  bill: {type: record, table: ${q(t.bills)}, required: true}
steps:
  - query:
      source: |
        from table ${q(t.bills)}
        select ${q(t.reference)}
        where record.id = @params.bill and record.finalizationState = 'finalized'
        limit 1
      parameters:
        bill: {type: record, value: "\${{ inputs.bill }}"}
      saveAs: issued
  - if:
      equals: ["\${{ issued.rowCount }}", 0]
    then:
${draftSteps
  .trimEnd()
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
  - generateDocument:
      template: ${q(t.documents)}
      record: inputs.bill
      saveAs: document
`;
};
