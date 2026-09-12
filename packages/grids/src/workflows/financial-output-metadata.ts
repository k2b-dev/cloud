import type { WorkflowFieldSchema } from "@k2b/cloud/workflows";

const column = {
  kind: "string",
  minLength: 1,
  maxLength: 200,
  description: "Exact captured GQL column alias, not a value expression.",
} as const;
const destination = {
  kind: "string",
  minLength: 1,
  maxLength: 200,
  description: "Stable, literal target identity used for duplicate prevention across runs. Never a date or per-run value.",
} as const;

/** Field semantics belong to the financial normalizer. Header values use the
 * existing workflow expression evaluator; mapping aliases and target stay literal. */
export const FINANCIAL_WORKFLOW_OUTPUTS = [
  {
    kind: "object",
    properties: {
      kind: {
        kind: "string",
        enum: ["datev-csv"],
        description: "DATEV 700/13 EUR booking batch. Manual invocation and preview confirmation required.",
      },
      version: { kind: "number", integer: true, minimum: 1, maximum: 1 },
      header: {
        kind: "object",
        properties: {
          destinationKey: destination,
          consultantNumber: { kind: "value", description: "Consultant number as digit string, 1001–9999999; literal or workflow value." },
          clientNumber: { kind: "value", description: "Client number as digit string, 1–99999; literal or workflow value." },
          fiscalYearStart: { kind: "value", description: "YYYY-MM-DD, in 2000–2099." },
          accountLength: { kind: "value", description: "Integer from 4 to 8." },
          periodStart: { kind: "value", description: "YYYY-MM-DD, within this fiscal year." },
          periodEnd: { kind: "value", description: "YYYY-MM-DD, on or after periodStart, within this fiscal year." },
          label: { kind: "value", description: "Batch label, 1–30 letters, digits, spaces, underscores, dots, slashes or hyphens." },
          finalize: {
            kind: "value",
            description: "Required boolean: whether DATEV should finalize on import. Does not finalize Grids records.",
          },
        },
      },
      mapping: {
        kind: "object",
        properties: {
          businessId: {
            ...column,
            description: "Stable business event identity, retained across joins/grouping. Each event is claimed once per target.",
          },
          entryId: { ...column, description: "Unique posting identity within each business event." },
          amount: { ...column, description: "Positive exact EUR amount, at most two effective decimal places; no rounding." },
          direction: { ...column, description: "S or H." },
          account: { ...column, description: "Digit string preserving leading zeros; length matches accountLength or accountLength + 1." },
          counterAccount: column,
          documentDate: { ...column, description: "YYYY-MM-DD within the batch period." },
          documentNumber: { ...column, description: "1–36 ASCII letters, digits or _$&%*+-/." },
          text: { ...column, optional: true },
          taxKey: { ...column, optional: true },
          costCenter1: { ...column, optional: true },
          costCenter2: { ...column, optional: true },
        },
      },
    },
  },
  {
    kind: "object",
    properties: {
      kind: {
        kind: "string",
        enum: ["sepa-xml"],
        description: "SEPA SCT pain.001.001.09 (DK GBIC 5), EUR only. Creates a file, never submits payment. Manual confirmation required.",
      },
      version: { kind: "number", integer: true, minimum: 1, maximum: 1 },
      header: {
        kind: "object",
        properties: {
          destinationKey: destination,
          debtorName: { kind: "value", description: "Account holder, 1–70 characters." },
          debtorIban: {
            kind: "value",
            description: "Valid SEPA IBAN in uppercase electronic format, without spaces. QR-IBAN is not supported.",
          },
          debtorBic: { kind: "value", optional: true, description: "Optional valid BIC." },
          executionDate: { kind: "value", description: "Requested execution date, YYYY-MM-DD; literal or workflow value." },
        },
      },
      mapping: {
        kind: "object",
        properties: {
          businessId: { ...column, description: "Unique stable business event identity. Each event is claimed once per target." },
          endToEndId: { ...column, description: "Unique payment reference, 1–35 SEPA characters." },
          amount: { ...column, description: "Positive exact EUR amount, at most two effective decimal places; no rounding." },
          creditorName: { ...column, description: "Payee name, 1–70 characters." },
          creditorIban: { ...column, description: "Valid SEPA IBAN, uppercase electronic format." },
          creditorBic: { ...column, optional: true },
          remittance: { ...column, description: "Remittance information, 1–140 characters." },
        },
      },
    },
  },
] as const satisfies readonly WorkflowFieldSchema[];
