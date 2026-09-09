import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { jsonResponse, requiresAuth } from "@k2b/cloud/server";
import type { WorkflowBoundPlan, WorkflowIr, WorkflowIrStep } from "@k2b/cloud/workflows";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  type MailWorkflow,
  type MailWorkflowDetail,
  type MailWorkflowVersion,
  ResourceShortIdSchema,
  type WorkflowAutocomplete,
  type WorkflowValidation,
  workflowEffectBudgetSchema,
  workflowJsonValueSchema,
} from "../contracts";

const responseSchema =
  <T>() =>
  <S extends z.ZodType<T>>(schema: S): S =>
    schema;

const workflowJsonObjectSchema = z.record(z.string(), workflowJsonValueSchema);
const workflowConditionJsonSchema = {
  $dynamicAnchor: "WorkflowCondition",
  oneOf: [
    {
      type: "object",
      properties: {
        operator: { enum: ["equals", "notEquals", "contains", "startsWith", "endsWith"] },
        operands: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          prefixItems: [{ $dynamicRef: "#WorkflowJsonValue" }, { $dynamicRef: "#WorkflowJsonValue" }],
        },
      },
      required: ["operator", "operands"],
    },
    {
      type: "object",
      properties: { operator: { const: "exists" }, reference: { type: "string" } },
      required: ["operator", "reference"],
    },
    {
      type: "object",
      properties: {
        operator: { enum: ["all", "any"] },
        conditions: { type: "array", items: { $dynamicRef: "#WorkflowCondition" } },
      },
      required: ["operator", "conditions"],
    },
    {
      type: "object",
      properties: { operator: { const: "not" }, condition: { $dynamicRef: "#WorkflowCondition" } },
      required: ["operator", "condition"],
    },
  ],
} as const;
const workflowIrStepJsonSchema = {
  $dynamicAnchor: "WorkflowIrStep",
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "action" },
        action: { type: "string" },
        config: { type: "object", additionalProperties: { $dynamicRef: "#WorkflowJsonValue" } },
        sourcePath: { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
      },
      required: ["kind", "action", "config", "sourcePath"],
    },
    {
      type: "object",
      properties: {
        kind: { const: "if" },
        condition: workflowConditionJsonSchema,
        then: { type: "array", items: { $dynamicRef: "#WorkflowIrStep" } },
        else: { type: "array", items: { $dynamicRef: "#WorkflowIrStep" } },
        sourcePath: { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
      },
      required: ["kind", "condition", "then", "else", "sourcePath"],
    },
    {
      type: "object",
      properties: {
        kind: { const: "switch" },
        value: { $dynamicRef: "#WorkflowJsonValue" },
        cases: {
          type: "array",
          items: {
            type: "object",
            properties: {
              when: { $dynamicRef: "#WorkflowJsonValue" },
              steps: { type: "array", items: { $dynamicRef: "#WorkflowIrStep" } },
            },
            required: ["when", "steps"],
          },
        },
        default: { type: "array", items: { $dynamicRef: "#WorkflowIrStep" } },
        sourcePath: { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
      },
      required: ["kind", "value", "cases", "default", "sourcePath"],
    },
    {
      type: "object",
      properties: {
        kind: { const: "forEach" },
        reference: { type: "string" },
        alias: { type: "string" },
        steps: { type: "array", items: { $dynamicRef: "#WorkflowIrStep" } },
        sourcePath: { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
      },
      required: ["kind", "reference", "alias", "steps", "sourcePath"],
    },
  ],
} as const;
const workflowIrStepSchema = z.unknown().meta(workflowIrStepJsonSchema) as z.ZodType<WorkflowIrStep>;
const workflowHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const workflowSourceLocationSchema = z.object({
  offset: z.number().int().nonnegative(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
});
const workflowDiagnosticSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(["error", "warning"]),
  path: z.array(z.union([z.string(), z.number()])),
  location: workflowSourceLocationSchema.optional(),
});
const workflowCompletionItemSchema = z.object({
  label: z.string(),
  kind: z.enum(["keyword", "source", "field", "literal"]),
  detail: z.string().optional(),
  insertText: z.string(),
  textEdit: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    text: z.string(),
  }),
  commitCharacters: z.array(z.string()).optional(),
});
const workflowIrShapeSchema = z.object({
  schemaVersion: z.literal(1),
  languageId: z.string(),
  languageVersion: z.number().int().positive(),
  sourceHash: workflowHashSchema,
  manifestHash: workflowHashSchema,
  inputs: z.array(z.object({ name: z.string(), type: z.string(), config: workflowJsonObjectSchema })),
  triggers: z.array(z.object({ kind: z.string(), config: workflowJsonObjectSchema, with: workflowJsonObjectSchema })),
  steps: z.array(workflowIrStepSchema),
  sourceLocations: z.record(z.string(), workflowSourceLocationSchema),
});
const workflowIrSchema = responseSchema<WorkflowIr>()(workflowIrShapeSchema);
const workflowBoundPlanSchema = responseSchema<WorkflowBoundPlan>()(
  z.object({
    schemaVersion: z.literal(2),
    languageId: z.string(),
    languageVersion: z.number().int().positive(),
    sourceHash: workflowHashSchema,
    manifestHash: workflowHashSchema,
    catalogHash: workflowHashSchema,
    maxLoopItems: z.number().int().positive().optional(),
    actionPolicies: z.record(
      z.string(),
      z.object({
        effect: z.enum(["pure", "transactional", "durable-intent", "ambiguous-external"]),
        dryRun: z.enum(["full", "validate", "unsupported"]),
      }),
    ),
    inputs: workflowIrShapeSchema.shape.inputs,
    triggers: workflowIrShapeSchema.shape.triggers,
    steps: workflowIrShapeSchema.shape.steps,
    bindings: workflowJsonObjectSchema,
  }),
);

export const workflowValidationSchema = responseSchema<WorkflowValidation>()(
  z.object({
    valid: z.boolean(),
    source: z.string(),
    sourceHash: workflowHashSchema.nullable(),
    ir: workflowIrSchema.nullable(),
    boundPlan: workflowBoundPlanSchema.nullable(),
    diagnostics: z.array(workflowDiagnosticSchema),
  }),
);
export const workflowAutocompleteSchema = responseSchema<WorkflowAutocomplete>()(
  z.object({
    diagnostics: z.array(workflowDiagnosticSchema),
    items: z.array(workflowCompletionItemSchema),
  }),
);
export const mailWorkflowSchema = responseSchema<MailWorkflow>()(
  z.object({
    id: z.string().uuid(),
    mailboxId: ResourceShortIdSchema,
    name: z.string(),
    description: z.string().nullable(),
    priority: z.number().int(),
    currentVersionId: z.string().uuid(),
    activeVersionId: z.string().uuid().nullable(),
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
);
export const mailWorkflowVersionSchema = responseSchema<MailWorkflowVersion>()(
  z.object({
    id: z.string().uuid(),
    identity: z.string(),
    workflowId: z.string().uuid(),
    mailboxId: ResourceShortIdSchema,
    source: z.string(),
    sourceHash: workflowHashSchema,
    boundPlan: workflowBoundPlanSchema,
    diagnostics: z.array(workflowDiagnosticSchema),
    effectBudget: workflowEffectBudgetSchema,
    languageId: z.string(),
    languageVersion: z.number().int().positive(),
    manifestHash: workflowHashSchema,
    createdAt: z.string().datetime(),
  }),
);
const mailWorkflowActivationSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  workflowVersionId: z.string().uuid(),
  key: z.string(),
  kind: z.string(),
  config: workflowJsonObjectSchema,
  enabled: z.boolean(),
  diagnostics: z.array(workflowDiagnosticSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const mailWorkflowDetailSchema = responseSchema<MailWorkflowDetail>()(
  mailWorkflowSchema.extend({
    currentVersion: mailWorkflowVersionSchema,
    activations: z.array(mailWorkflowActivationSchema),
  }),
);
const errorResponses = {
  400: jsonResponse(ErrorResponseSchema, "Invalid request"),
  401: jsonResponse(ErrorResponseSchema, "Authentication required"),
  403: jsonResponse(ErrorResponseSchema, "Forbidden"),
  404: jsonResponse(ErrorResponseSchema, "Not found"),
  409: jsonResponse(ErrorResponseSchema, "Conflict"),
  500: jsonResponse(ErrorResponseSchema, "Internal server error"),
};
type ErrorStatus = keyof typeof errorResponses;

export const workflowOperation = <T extends z.ZodType>(
  summary: string,
  successSchema: T,
  successDescription: string,
  additionalErrors: readonly Exclude<ErrorStatus, 400 | 401 | 403 | 500>[] = [],
) =>
  describeRoute({
    tags: ["Mail:Workflows"],
    summary,
    ...requiresAuth,
    responses: {
      200: jsonResponse(successSchema, successDescription),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      500: errorResponses[500],
      ...Object.fromEntries(additionalErrors.map((status) => [status, errorResponses[status]])),
    },
  });
