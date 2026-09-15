import type { WorkflowActionMap, WorkflowFieldSchema } from "@k2b/cloud/workflows";
import { MAX_ATOMIC_LOCK_RECORDS, MAX_CORRECTION_PREFILL_FIELDS } from "./contracts";
import { FINANCIAL_WORKFLOW_OUTPUTS } from "./financial-output-metadata";
import { WORKFLOW_QUERY_PARAMETER_TYPES } from "./query-parameters";

const snapshotColumns = {
  kind: "array",
  minItems: 1,
  items: {
    kind: "object",
    properties: {
      key: { kind: "string", minLength: 1 },
      label: { kind: "string", minLength: 1, optional: true },
      type: { kind: "string", enum: ["text", "decimal", "boolean", "date", "dateTime", "json"] },
      path: {
        kind: "array",
        minItems: 1,
        items: { kind: "string", minLength: 1 },
        description: "Literal own-property path in the public snapshot. No live values or array expansion.",
      },
    },
  },
} satisfies WorkflowFieldSchema;

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

const querySource = {
  kind: "string",
  minLength: 1,
  maxLength: 20_000,
  description: "Inline GQL with an explicit table source and optional @params.name values. Grouped summary View joins pin their definitions at publication.",
} as const;
const queryParameters = {
  kind: "record",
  optional: true,
  description: "Typed values keyed by lowercase parameter names; reference them in GQL as @params.name.",
  values: {
    kind: "object",
    properties: {
      type: {
        kind: "string",
        enum: [...WORKFLOW_QUERY_PARAMETER_TYPES],
        description: "Parameter type. Decimal values must be exact decimal strings.",
      },
      value: { kind: "value", description: "Literal or workflow expression. Record values use existing record inputs or outputs." },
    },
  },
} satisfies WorkflowFieldSchema;
const atomicAssertion = {
  assert: { kind: "string", enum: ["empty", "notEmpty"], description: "Whether the query must match no records or at least one record." },
  message: { kind: "string", minLength: 1, maxLength: 500, optional: true, description: "Failure shown when the assertion is false." },
} satisfies Record<string, WorkflowFieldSchema>;

export const GRIDS_WORKFLOW_ACTION_METADATA = {
  query: {
    effect: "transactional",
    label: "Capture query data",
    description: "Captures a complete, typed GQL result once for later document generation. Parameters are values, not query text.",
    outputType: "grids.queryResult",
    config: {
      kind: "object",
      properties: {
        source: querySource,
        parameters: queryParameters,
        saveAs,
      },
    },
  },
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
        values: {
          kind: "record",
          optional: true,
          values: { kind: "value", description: "Explicit draft input, including required relations or new dates." },
          description: "Initial values override copied inputs, but cannot override typeField or originalField.",
        },
        saveAs,
      },
    },
  },
  deleteRecord: {
    effect: "transactional",
    label: "Move record to trash",
    description: "Moves one non-finalized record to trash after current permission, mutation-policy, and audit checks. Does not destroy its data.",
    outputType: "grids.record",
    config: {
      kind: "object",
      properties: {
        record: { kind: "string", minLength: 1, maxLength: 500, description: "Record input or output reference." },
        audit: auditAnswers,
        saveAs,
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
          maxItems: MAX_ATOMIC_LOCK_RECORDS,
          items: { kind: "string", minLength: 1, maxLength: 500, description: "Record or record-list reference used to coordinate concurrent runs." },
          description: "At most 100 distinct records across explicit locks, change targets and validateDocuments targets together, locked in stable order before checks run.",
        },
        checks: {
          kind: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            kind: "union",
            variants: [
              {
                kind: "object",
                properties: {
                  query: { kind: "object", properties: { source: querySource, parameters: queryParameters } },
                  ...atomicAssertion,
                },
              },
              {
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
                  ...atomicAssertion,
                },
              },
            ],
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
                  finalizeRecord: {
                    kind: "object",
                    properties: {
                      record: {
                        kind: "string",
                        minLength: 1,
                        maxLength: 500,
                        description: "Existing record reference to finalize after the checks pass in the same transaction.",
                      },
                    },
                  },
                },
              },
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
          description: "Record creates, updates and finalizations committed in order. A later failure rolls back every change.",
        },
        validateDocuments: {
          kind: "array",
          optional: true,
          minItems: 1,
          maxItems: 50,
          items: {
            kind: "object",
            properties: {
              template: { kind: "string", minLength: 1, maxLength: 200, description: "Profile document template to validate." },
              record: { kind: "string", minLength: 1, maxLength: 500, description: "Existing record reference, read after the changes." },
            },
          },
          description:
            "Validate profile inputs after changes, before commit. Failure rolls back changes. Does not render or issue a document.",
        },
      },
    },
  },
  generateDocument: {
    effect: "idempotent",
    label: "Generate document",
    description: "Creates an immutable document from a record template or captured query data.",
    outputType: "grids.document",
    config: {
      kind: "object",
      properties: {
        associatedData: {
          kind: "string",
          optional: true,
          minLength: 1,
          description:
            "Saved single-table row query defining the records associated with this document. Uses frozen IDs and versions, never re-runs the query. Only with data/output. Without this, simple row queries associate their own records; joins and aggregates imply no membership. Does not replace sourceVersions freshness checks.",
        },
        sourceVersions: {
          kind: "value",
          optional: true,
          description:
            "Financial outputs only: data pins unique single-source GQL Record versions from the capture; otherwise use a nonempty unique array of {tableId, recordId, version} with public IDs and positive integer versions. Rechecks and locks these records at confirmation and issuance. Include every approval or child Record whose changes matter.",
        },
        template: {
          kind: "string",
          minLength: 1,
          maxLength: 200,
          optional: true,
          description: "Document template; requires record and excludes data/output.",
        },
        record: { kind: "string", minLength: 1, maxLength: 500, optional: true, description: "Record reference for the template source." },
        data: {
          kind: "union",
          optional: true,
          description: "Captured query reference or typed rows; requires output and excludes template/record.",
          variants: [
            { kind: "string", minLength: 1, maxLength: 500, description: "Captured query reference." },
            {
              kind: "object",
              properties: {
                documents: { kind: "value", description: "Ordered unique public IDs of issued Documents in this Base (1–10,000)." },
                columns: snapshotColumns,
              },
            },
            {
              kind: "object",
              properties: {
                snapshots: {
                  kind: "value",
                  description:
                    "Ordered unique public Record snapshot IDs in this Base. Read public snapshot properties such as root.data.FIELD1; relations use current access.",
                },
                columns: snapshotColumns,
              },
            },
            {
              kind: "object",
              properties: {
                columns: {
                  kind: "array",
                  minItems: 1,
                  items: {
                    kind: "object",
                    properties: {
                      key: { kind: "string", minLength: 1, description: "Literal row property key." },
                      label: { kind: "string", minLength: 1, optional: true, description: "Optional literal column label." },
                      type: {
                        kind: "string",
                        enum: ["text", "decimal", "boolean", "date", "dateTime", "json"],
                        description: "Exact column type; decimal cells are strings.",
                      },
                    },
                  },
                },
                rows: {
                  kind: "value",
                  description:
                    "Array of row objects. Values may use workflow expressions; every declared cell is required, null is allowed.",
                },
              },
            },
          ],
        },
        output: {
          kind: "union",
          optional: true,
          variants: [
            ...FINANCIAL_WORKFLOW_OUTPUTS,
            {
              kind: "object",
              properties: {
                kind: { kind: "string", enum: ["xml"], description: "UTF-8 XML 1.0; not a financial profile." },
                body: {
                  kind: "string",
                  minLength: 1,
                  maxLength: 200_000,
                  description: "XML/Liquid using rows, columns and document. Static names and namespaces only.",
                },
              },
            },
            {
              kind: "object",
              properties: {
                kind: { kind: "string", enum: ["pdf"], description: "One PDF from all captured rows." },
                body: { kind: "string", minLength: 1, maxLength: 200_000, description: "HTML/Liquid using rows, columns and document." },
                header: { kind: "string", minLength: 1, maxLength: 50_000, optional: true },
                footer: { kind: "string", minLength: 1, maxLength: 50_000, optional: true },
                css: { kind: "string", minLength: 1, maxLength: 50_000, optional: true },
              },
            },
            {
              kind: "object",
              properties: {
                kind: { kind: "string", enum: ["json"], description: "JSON row objects." },
                wrapper: {
                  kind: "object",
                  optional: true,
                  description: "Optional root object containing rows and additional typed values. No text template.",
                  properties: {
                    rowsKey: { kind: "string", minLength: 1, description: "Root property holding the row array." },
                    values: {
                      kind: "record",
                      values: { kind: "value" },
                      optional: true,
                      description: "Other root properties; literals or workflow values. Must not contain rowsKey.",
                    },
                  },
                },
              },
            },
            {
              kind: "object",
              properties: {
                kind: { kind: "string", enum: ["csv"], description: "UTF-8 CSV." },
                columns: {
                  kind: "array",
                  optional: true,
                  minItems: 1,
                  description: "Optional ordered selection by exact GQL alias. Omitted columns are not exported; labels may be renamed.",
                  items: {
                    kind: "object",
                    properties: {
                      source: { kind: "string", minLength: 1, description: "Exact captured GQL column alias, not its internal key." },
                      label: { kind: "string", minLength: 1, optional: true, description: "Export heading; defaults to the source alias." },
                    },
                  },
                },
                delimiter: {
                  kind: "string",
                  enum: [",", ";", "\t", "|"],
                  optional: true,
                  description: "Column separator; defaults to comma.",
                },
                nestedValues: {
                  kind: "string",
                  enum: ["reject", "json"],
                  optional: true,
                  description: "Nested cell handling; defaults to rejection.",
                },
                textProtection: {
                  kind: "string",
                  enum: ["spreadsheet", "raw"],
                  optional: true,
                  description: "Spreadsheet-safe text by default; raw keeps unsafe formula-like text.",
                },
              },
            },
          ],
        },
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
