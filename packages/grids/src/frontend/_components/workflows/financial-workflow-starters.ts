import { stringify } from "yaml";
import { z } from "zod";
import type { FinancialDocumentOutput } from "../../../service/document-financial-output";

// Public IDs are embedded into GQL identifiers, never free-form names or values.
const id = (value: string) =>
  z
    .string()
    .regex(/^[A-Za-z0-9]{6}$/)
    .parse(value);
type DatevHeader = Extract<FinancialDocumentOutput, { kind: "datev-csv" }>["header"];
type SepaHeader = Extract<FinancialDocumentOutput, { kind: "sepa-xml" }>["header"];

/** Accounting fields must already be part of the issued Record snapshot.
 * In particular, direction is explicitly authored, not inferred from the sign. */
export const invoiceAccountingStarterSource = (params: {
  header: DatevHeader;
  fields: { direction: string; account: string; counterAccount: string };
}) =>
  stringify(
    {
      inputs: { document: { type: "text", required: true } },
      steps: [
        {
          generateDocument: {
            data: {
              documents: ["${{ inputs.document }}"],
              columns: [
                { key: "businessId", type: "text", path: ["data", "record", "id"] },
                { key: "entryId", type: "text", path: ["number"] },
                { key: "amount", type: "decimal", path: ["output", "grossAmount"] },
                ...Object.entries(params.fields).map(([key, fieldId]) => ({
                  key,
                  type: "text",
                  path: ["data", "record", "data", id(fieldId)],
                })),
                { key: "documentDate", type: "date", path: ["profile", "invoiceDate"] },
                { key: "documentNumber", type: "text", path: ["number"] },
              ],
            },
            output: {
              kind: "datev-csv",
              version: 1,
              header: params.header,
              mapping: Object.fromEntries(
                ["businessId", "entryId", "amount", "direction", "account", "counterAccount", "documentDate", "documentNumber"].map(
                  (key) => [key, key],
                ),
              ),
            },
            saveAs: "exported",
          },
        },
      ],
    },
    { lineWidth: 100, aliasDuplicateObjects: false },
  );

/** businessId is a required, unique, immutable reimbursement number field.
 * The caller must select that field explicitly; a regenerated batch ID is unsafe. */
export const expensePaymentStarterSource = (params: {
  tableId: string;
  fieldReferences: string[];
  header: SepaHeader;
  fields: { businessId: string; amount: string; creditorName: string; creditorIban: string; remittance: string };
  notFinalizedMessage: string;
}) => {
  const table = id(params.tableId);
  const reserved = new Set(params.fieldReferences.map((reference) => reference.toLowerCase()));
  const alias = (key: string) => {
    let value = `export_${key}`;
    while (reserved.has(value.toLowerCase())) value = `_${value}`;
    return value;
  };
  const selection = "oneof(record.id, @params.selected)";
  const parameters = { selected: { type: "recordList", value: "${{ inputs.records }}" } };
  return stringify(
    {
      inputs: { records: { type: "recordList", table, required: true } },
      steps: [
        {
          query: {
            source: `from table {${table}}\nselect {${id(params.fields.businessId)}}\nwhere ${selection} and oneof(record.finalizationState, 'draft', 'awaitingReview')`,
            parameters,
            saveAs: "unfinished",
          },
        },
        {
          if: { equals: ["${{ unfinished.rowCount }}", 0] },
          then: [
            {
              query: {
                source: `from table {${table}}\nselect ${Object.entries(params.fields)
                  .map(([key, field]) => `{${id(field)}} as ${alias(key)}`)
                  .join(", ")}\nwhere ${selection} and record.finalizationState = 'finalized'`,
                parameters,
                saveAs: "payments",
              },
            },
            {
              generateDocument: {
                data: "payments",
                sourceVersions: "data",
                output: {
                  kind: "sepa-xml",
                  version: 1,
                  header: params.header,
                  mapping: {
                    businessId: alias("businessId"),
                    endToEndId: alias("businessId"),
                    amount: alias("amount"),
                    creditorName: alias("creditorName"),
                    creditorIban: alias("creditorIban"),
                    remittance: alias("remittance"),
                  },
                },
                saveAs: "exported",
              },
            },
          ],
          else: [{ fail: { message: params.notFinalizedMessage } }],
        },
      ],
    },
    { lineWidth: 100, aliasDuplicateObjects: false },
  );
};
