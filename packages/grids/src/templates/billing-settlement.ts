import type { BillingText } from "./billing";
import { billingIssueOrRetrieveSource } from "./billing-issuance";
import type { GridTemplate } from "./types";

/** Self-billing uses the saved positions on one bill, just like invoices. */
export const billingSettlementWorkflow = (t: BillingText): NonNullable<GridTemplate["workflows"]>[number] => {
  const q = JSON.stringify;
  const parameters = `
              bill: {type: record, value: "\${{ inputs.bill }}"}
              party: {type: record, value: "\${{ inputs.bill.${t.party} }}"}
              settings: {type: record, value: "\${{ inputs.bill.${t.settings} }}"}
              agreement: {type: text, value: "\${{ inputs.bill.${t.agreement} }}"}`;
  const check = (source: string, assertion: "empty" | "notEmpty" = "notEmpty", message = t.settlementError) => `        - query:
            source: |
${source
  .split("\n")
  .map((line) => `              ${line}`)
  .join("\n")}
            parameters:${parameters}
          assert: ${assertion}
          message: ${q(message)}
`;
  const checks = [
    check(
      `from table ${q(t.parties)}
select ${q(t.iban)}
where record.id = @params.party and ${q(t.iban)} != null and ${q(t.accountName)} != null
limit 1`,
      "notEmpty",
      t.settlementBankError,
    ),
    check(`from table ${q(t.settings)}
select ${q(t.setupKey)}
where record.id = @params.settings and ${q(t.setupKey)} = 'issuer' and ${q(t.ready)} = true
limit 1`),
    // Parameters are resolved before locks. Reject changed identities, agreement
    // rather than finalizing a different draft under stale locks.
    check(`from table ${q(t.bills)}
select ${q(t.reference)}
where record.id = @params.bill and record.finalizationState = 'draft' and ${q(t.kind)} = 'selfBilling' and ${q(t.party)} = @params.party and ${q(t.settings)} = @params.settings and ${q(t.agreement)} = @params.agreement
limit 1`),
  ].join("");
  return {
    key: "issue_self_billing",
    name: t.issueSelfBilling,
    enabled: true,
    source: billingIssueOrRetrieveSource(
      t,
      `  - if:
      equals: ["\${{ inputs.bill.${t.agreement} }}", null]
    then:
      - fail: {message: ${q(t.settlementAgreementError)}}
  - atomicRecords:
      locks: [inputs.bill, ${q(`inputs.bill.${t.settings}`)}, ${q(`inputs.bill.${t.party}`)}]
      checks:
${checks}      changes:
        - finalizeRecord: {record: inputs.bill}
      validateDocuments:
        - template: ${q(t.documents)}
          record: inputs.bill
`,
    ),
  };
};
