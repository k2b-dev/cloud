import type { WorkflowActionMap } from "@valentinkolb/cloud/workflows";
import { MAX_CORRECTION_PREFILL_FIELDS } from "./contracts";

const saveAs = {
  kind: "string",
  format: "identifier",
  maxLength: 120,
  optional: true,
  description: "Name used to reference this action output in later steps.",
} as const;

const auditAnswers = {
  kind: "record",
  values: { kind: "value", description: "Answer value or select-option UUID." },
  optional: true,
  description: "Audit answers keyed by the table audit-question UUID.",
} as const;

export const GRIDS_WORKFLOW_ACTION_METADATA = {
  closeRecord: {
    effect: "transactional",
    label: "Close record",
    description: "Finalizes directly or requests Four-eyes Finalization, according to the Table's current mode.",
    outputType: "grids.record",
    config: {
      kind: "object",
      properties: {
        record: { kind: "string", minLength: 1, maxLength: 500, description: "Record input or output reference." },
        expectedMode: {
          kind: "string",
          minLength: 1,
          maxLength: 500,
          optional: true,
          description: "Optional text reference that pins the previewed Direct or Four-eyes mode.",
        },
        expectedPolicyRevision: {
          kind: "string",
          minLength: 1,
          maxLength: 500,
          optional: true,
          description: "Optional number reference that pins the previewed Finalization policy revision.",
        },
      },
    },
  },
  createCorrectionDraft: {
    effect: "transactional",
    label: "Create linked follow-up Draft",
    description: "Creates one follow-up Draft linked to an unchanged finalized Record in the same Table.",
    outputType: "grids.record",
    config: {
      kind: "object",
      properties: {
        original: { kind: "string", minLength: 1, maxLength: 500, description: "Finalized original Record reference." },
        intent: {
          kind: "string",
          enum: ["correction", "cancellation"],
          optional: true,
          description: "Follow-up intent. Older workflows without it remain corrections.",
        },
        typeField: { kind: "string", minLength: 1, maxLength: 200, description: "Single-select field used for the follow-up type." },
        typeValue: { kind: "string", minLength: 1, maxLength: 200, description: "Existing select-option ID for the follow-up Draft." },
        originalField: {
          kind: "string",
          minLength: 1,
          maxLength: 200,
          description: "Single self-relation that links the correction to its original Record.",
        },
        copyFields: {
          kind: "array",
          items: { kind: "string", minLength: 1, maxLength: 200, description: "Stored value field copied from the original Record." },
          maxItems: MAX_CORRECTION_PREFILL_FIELDS,
          optional: true,
          description: "Explicit stored value fields carried into the correction Draft.",
        },
      },
    },
  },
  finalizeRecord: {
    effect: "transactional",
    label: "Finalize record",
    description: "Validates and permanently locks one record after a current permission check.",
    outputType: "grids.record",
    config: {
      kind: "object",
      properties: {
        record: { kind: "string", minLength: 1, maxLength: 500, description: "Record input or output reference." },
      },
    },
  },
  updateRecord: {
    effect: "transactional",
    label: "Update record",
    description: "Updates fields on one record after a current permission check.",
    outputType: "grids.record",
    config: {
      kind: "object",
      properties: {
        record: { kind: "string", minLength: 1, maxLength: 500, description: "Record input or output reference." },
        set: {
          kind: "record",
          minProperties: 1,
          values: { kind: "value", description: "Fields and values to update." },
          description: "Fields and values to update.",
        },
        audit: auditAnswers,
      },
    },
  },
  createRecord: {
    effect: "transactional",
    label: "Create record",
    description: "Creates one record in a table after a current permission check.",
    outputType: "grids.record",
    config: {
      kind: "object",
      properties: {
        table: { kind: "string", minLength: 1, maxLength: 200, description: "Target table name or ID." },
        values: {
          kind: "record",
          minProperties: 1,
          values: { kind: "value", description: "Initial field values." },
          description: "Initial field values.",
        },
        saveAs,
      },
    },
  },
  atomicRecords: {
    effect: "transactional",
    label: "Atomic record change",
    description: "Locks records, checks current Grids data, and commits bounded record changes together or not at all.",
    config: {
      kind: "object",
      properties: {
        locks: {
          kind: "array",
          minItems: 1,
          maxItems: 100,
          items: { kind: "string", minLength: 1, maxLength: 500, description: "Record reference used to coordinate concurrent runs." },
          description: "Records locked in stable order before checks run.",
        },
        checks: {
          kind: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            kind: "object",
            properties: {
              table: { kind: "string", minLength: 1, maxLength: 200, description: "Table queried by this check." },
              where: {
                kind: "array",
                minItems: 1,
                maxItems: 20,
                items: {
                  kind: "object",
                  properties: {
                    field: { kind: "string", minLength: 1, maxLength: 200, description: "Field name or ID." },
                    op: { kind: "string", minLength: 1, maxLength: 80, description: "Grids filter operator." },
                    value: { kind: "value", optional: true, description: "Filter value." },
                    caseInsensitive: { kind: "boolean", optional: true, description: "Use case-insensitive text comparison." },
                  },
                },
                description: "Bound predicates combined with AND.",
              },
              assert: {
                kind: "string",
                enum: ["empty", "notEmpty"],
                description: "Whether the query must match no records or at least one record.",
              },
              message: {
                kind: "string",
                minLength: 1,
                maxLength: 500,
                optional: true,
                description: "Failure shown when the assertion is false.",
              },
            },
          },
          description: "Current-state assertions evaluated while coordination records are locked.",
        },
        changes: {
          kind: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            kind: "union",
            variants: [
              {
                kind: "object",
                properties: {
                  createRecord: {
                    kind: "object",
                    properties: {
                      table: { kind: "string", minLength: 1, maxLength: 200, description: "Target table name or ID." },
                      values: {
                        kind: "record",
                        minProperties: 1,
                        values: { kind: "value", description: "Initial field values." },
                        description: "Initial field values.",
                      },
                    },
                  },
                },
              },
              {
                kind: "object",
                properties: {
                  updateRecord: {
                    kind: "object",
                    properties: {
                      record: { kind: "string", minLength: 1, maxLength: 500, description: "Record input or output reference." },
                      set: {
                        kind: "record",
                        minProperties: 1,
                        values: { kind: "value", description: "Fields and values to update." },
                        description: "Fields and values to update.",
                      },
                      ifVersion: {
                        kind: "number",
                        integer: true,
                        minimum: 1,
                        optional: true,
                        description: "Optional optimistic record version.",
                      },
                      audit: auditAnswers,
                    },
                  },
                },
              },
            ],
          },
          description: "Record creates and updates committed in order.",
        },
      },
    },
  },
  generateDocument: {
    effect: "idempotent",
    label: "Generate document",
    description: "Creates a frozen document snapshot from a configured template.",
    outputType: "grids.document",
    config: {
      kind: "object",
      properties: {
        template: { kind: "string", minLength: 1, maxLength: 200, description: "Document template name or ID." },
        record: { kind: "string", minLength: 1, maxLength: 500, description: "Record input or output reference." },
        filename: { kind: "value", optional: true, description: "Optional filename override." },
        tags: { kind: "array", items: { kind: "value", description: "Tag value." }, maxItems: 20, optional: true },
        saveAs,
      },
    },
  },
  createDocumentLink: {
    effect: "transactional",
    label: "Create document link",
    description: "Creates a revocable public download link for a generated document.",
    outputType: "grids.documentLink",
    config: {
      kind: "object",
      properties: {
        document: { kind: "string", minLength: 1, maxLength: 500, description: "Document output reference." },
        expiresIn: { kind: "string", enum: ["1d", "7d", "30d", "90d"], optional: true, description: "How long the link stays valid." },
        comment: { kind: "value", optional: true, description: "Optional link comment." },
        saveAs,
      },
    },
  },
  sendEmail: {
    effect: "idempotent",
    label: "Send email",
    description: "Renders a Grids email template and delivers it to each recipient exactly once.",
    outputType: "grids.emailDelivery",
    config: {
      kind: "object",
      properties: {
        template: { kind: "string", minLength: 1, maxLength: 200, description: "Email template name or ID." },
        to: {
          kind: "array",
          minItems: 1,
          maxItems: 50,
          description: "Recipients, by address or by Cloud user.",
          items: {
            kind: "union",
            variants: [
              { kind: "object", properties: { email: { kind: "value", description: "Email address." } } },
              { kind: "object", properties: { user: { kind: "value", description: "User ID." } } },
            ],
          },
        },
        data: { kind: "record", values: { kind: "value", description: "Template value." }, optional: true, maxProperties: 200 },
        saveAs,
      },
    },
  },
  httpRequest: {
    effect: "ambiguous",
    label: "HTTP request",
    description: "Sends an explicit JSON HTTP request. Ambiguous remote outcomes are never retried blindly.",
    outputType: "core.value",
    config: {
      kind: "object",
      properties: {
        method: { kind: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], optional: true, description: "HTTP method." },
        url: { kind: "string", format: "uri", maxLength: 4_000, description: "HTTP or HTTPS URL." },
        headers: {
          kind: "record",
          values: { kind: "string", minLength: 1, maxLength: 1_000, description: "Header value." },
          optional: true,
          maxProperties: 100,
        },
        json: { kind: "value", optional: true, description: "JSON request payload." },
        timeoutMs: { kind: "number", integer: true, minimum: 1_000, maximum: 60_000, optional: true, description: "Request timeout." },
        saveAs,
      },
    },
  },
} as const satisfies Record<string, Pick<WorkflowActionMap[string], "label" | "description" | "outputType" | "config" | "effect">>;
