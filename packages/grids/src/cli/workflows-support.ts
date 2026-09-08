import type { CloudCliContext } from "@valentinkolb/cloud/cli";
import { flag } from "@valentinkolb/cloud/cli";
import type { PublicBase as Base } from "../api/public-dto";
import type { EmailTemplate } from "../contracts";
import type {
  GridsWorkflowLauncher,
  GridsWorkflow as Workflow,
  GridsWorkflowEmailDelivery as WorkflowEmailDelivery,
  GridsWorkflowRun as WorkflowRun,
  GridsWorkflowStepRun as WorkflowStepRun,
} from "../workflows/contracts";
import { gridsWorkflowManifest } from "../workflows/manifest";
import { resolveBaseFromCommand, resolveNamedResource } from "./resources";
import { readApi, requireRestArg } from "./runtime";

export type WorkflowRunListResponse = { items: WorkflowRun[]; nextCursor?: string | null };

export type WorkflowStepRunListResponse = { items: WorkflowStepRun[]; truncated: boolean };

export type WorkflowEmailDeliveryListResponse = { items: WorkflowEmailDelivery[]; nextCursor?: string | null };

export type WorkflowValidateResponse =
  | { ok: true; plan: unknown }
  | { ok: false; diagnostics: Array<{ message: string; path?: Array<string | number>; line?: number; column?: number }> };

export const JSON_BODY_NAMED_INPUT = flag.input({
  name: "body",
  fileName: "body-file",
  stdinName: false,
  valueLabel: "json",
});

export const WORKFLOW_SOURCE_INPUT = flag.input({
  name: "source",
  fileName: "source-file",
  fileAliases: ["f"],
  stdinName: "stdin",
  valueLabel: "yaml",
});

export const WORKFLOW_INPUTS_INPUT = flag.input({
  name: "inputs",
  fileName: "inputs-file",
  fileAliases: ["f"],
  stdinName: "stdin",
  valueLabel: "json",
});

export const WORKFLOW_LAUNCHER_BODY_INPUT = flag.input({
  name: "body",
  fileName: "body-file",
  fileAliases: ["f"],
  stdinName: "stdin",
  valueLabel: "json",
});

export const emailTemplateFlag = {
  template: flag.string({ description: "Email template public id or exact name" }),
};

export const workflowFlag = {
  workflow: flag.string({ description: "Workflow public id or exact name" }),
};

export const workflowLauncherFlag = {
  launcher: flag.string({ description: "Launcher public id or exact name" }),
};

export const EMAIL_TEMPLATE_REFERENCE = {
  fields: {
    name: "Template label shown in workflow email actions.",
    subject: "Liquid subject template.",
    html: "Liquid HTML email body. There is no plain-text fallback field.",
    sampleData: "JSON object stored with the template and exposed under data in the editor preview.",
    enabled: "Disabled templates cannot be selected in normal workflow flows.",
  },
  liquidData: ["workflow.name", "run.id", "data.<key>", "app.name", "business.legalName", "date.iso"],
  workflowUse: "Use sendEmail with template, to, optional data, and optional saveAs.",
  example: {
    subject: "Loan reminder for {{ data.itemName }}",
    html: "<p>Hello {{ data.customerName }},</p><p>Please return {{ data.itemName }}.</p>",
    sampleData: {
      customerName: "Alex Morgan",
      itemName: "Camera kit",
    },
    step: "sendEmail:\n  template: Reminder\n  to:\n    - email: ${{ inputs.email }}\n  data:\n    itemName: ${{ inputs.item.Name }}",
  },
};

export const WORKFLOW_REFERENCE = {
  language: {
    id: gridsWorkflowManifest.id,
    version: gridsWorkflowManifest.version,
    limits: gridsWorkflowManifest.limits,
    topLevel: ["inputs", "triggers", "steps"],
    inputs: gridsWorkflowManifest.inputs,
    triggers: gridsWorkflowManifest.triggers,
    actions: gridsWorkflowManifest.actions,
    controlFlow: ["if/then/else", "switch/cases/default", "forEach/as/do"],
    recordValues:
      "Record targets use references such as inputs.item. Relation field values and relation filters use public Record IDs, for example ${{ inputs.item.recordId }}, never internal UUIDs or display labels.",
    atomicPredicates:
      "Checks use stored-field filter operators. Formula fields and aggregate arithmetic are not supported; check the stored facts under the same coordination lock.",
    conditions: {
      equals: "Exact value equality; notEquals negates it.",
      notEquals: "Exact value inequality.",
      includes: "List membership: [list, value].",
      textEquals: "Normalized, case-insensitive text equality: [text, text].",
      contains: "Normalized, case-insensitive text containment: [text, text], not list membership.",
      startsWith: "Normalized, case-insensitive text prefix: [text, text].",
      endsWith: "Normalized, case-insensitive text suffix: [text, text].",
      exists: "Whether a binding has a value.",
      all: "Every nested condition matches.",
      any: "At least one nested condition matches.",
      not: "Negates one nested condition.",
    },
  },
  invocation: {
    direct: {
      mode: "execute",
      inputs: { item: "Rec001" },
      idempotencyKey: "agent-job-42",
      expectedRevision: 3,
    },
    scanner: {
      operationId: "scan-42",
      mode: "execute",
      expectedRevision: 3,
      scannedText: "gsc_opaque",
      inputs: {},
    },
    bulkRecordIds: {
      operationId: "bulk-42",
      mode: "execute",
      expectedRevision: 3,
      recordIds: ["Rec001"],
      inputs: {},
    },
    closeSelectionRecordIds: {
      operationId: "close-42",
      mode: "execute",
      expectedRevision: 3,
      recordIds: ["Rec001"],
      inputs: { closeMode: "fourEyes", closePolicyRevision: 2 },
    },
    correctionDraftRecord: {
      operationId: "correction-42",
      mode: "execute",
      expectedRevision: 3,
      recordId: "Rec001",
      inputs: {},
    },
    bulkQuery: {
      operationId: "bulk-query-42",
      mode: "dryRun",
      expectedRevision: 3,
      query: { limit: 100 },
      inputs: {},
    },
    customApp: {
      operationId: "customApp-42",
      mode: "execute",
      expectedRevision: 3,
      inputs: {},
    },
    customAppPrompt: {
      operationId: "customApp-43",
      mode: "execute",
      expectedRevision: 3,
      inputs: { range: "30d" },
    },
  },
  launchers: {
    scanner: {
      name: "Scan item",
      config: { kind: "scanner", input: "item", resolve: { by: "scanCode" } },
      enabled: true,
    },
    scannerByField: {
      name: "Scan asset tag",
      config: { kind: "scanner", input: "item", resolve: { by: "field", field: "Asset tag" } },
      enabled: true,
    },
    bulk: { name: "Process selection", config: { kind: "bulk", input: "items" }, enabled: true },
    explicitBulk: {
      name: "Close selection",
      config: {
        kind: "bulk",
        input: "records",
        profile: "closeSelection",
      },
      enabled: true,
    },
    correctionDraft: {
      name: "Create correction",
      config: { kind: "record", input: "original", profile: "correctionDraft", intent: "correction" },
      enabled: true,
    },
    cancellationDraft: {
      name: "Create cancellation",
      config: { kind: "record", input: "original", profile: "correctionDraft", intent: "cancellation" },
      enabled: true,
    },
    customApp: {
      name: "Run report",
      config: { kind: "customApp", label: "Refresh", inputMode: "fixed", inputBindings: { range: "30d" } },
      enabled: true,
    },
    customAppPrompt: {
      name: "Run report",
      config: { kind: "customApp", label: "Run", inputMode: "prompt" },
      enabled: true,
    },
  },
  values: {
    literals: "Plain strings are literal values, including strings containing dots.",
    dynamic: "Use an exact ${{ inputs.name }}, ${{ savedValue }}, or ${{ now() }} expression for dynamic WorkflowValue strings.",
    messages: "succeed/fail messages may embed ${{ ... }} expressions inside literal text.",
    dedicatedReferences: "record, forEach, document, and exists are reference slots and stay raw (for example, record: inputs.item).",
    scope: "Inputs exist for the whole run; saved values exist after their step; forEach aliases exist only inside do.",
  },
  example:
    "inputs:\n  item:\n    type: record\n    table: Items\n    required: true\nsteps:\n  - setVariable:\n      name: ranAt\n      value: ${{ now() }}\n  - updateRecord:\n      record: inputs.item\n      set:\n        Status: Checked",
  closeSelectionExample:
    "inputs:\n  records:\n    type: recordList\n    table: Items\n    required: true\n  closeMode:\n    type: text\n    required: true\n  closePolicyRevision:\n    type: number\n    required: true\nsteps:\n  - forEach: inputs.records\n    as: record\n    do:\n      - closeRecord:\n          record: record\n          expectedMode: inputs.closeMode\n          expectedPolicyRevision: inputs.closePolicyRevision",
};

export const listEmailTemplates = (ctx: CloudCliContext, baseId: string): Promise<EmailTemplate[]> =>
  readApi<EmailTemplate[]>(ctx, `/email-templates/by-base/${encodeURIComponent(baseId)}`);

const resolveEmailTemplate = async (ctx: CloudCliContext, baseId: string, ref: string): Promise<EmailTemplate> => {
  const template = resolveNamedResource(await listEmailTemplates(ctx, baseId), ref, "email template");
  return template;
};

export const listWorkflows = (ctx: CloudCliContext, baseId: string): Promise<Workflow[]> =>
  readApi<Workflow[]>(ctx, `/workflows/by-base/${encodeURIComponent(baseId)}`);

export const resolveWorkflow = async (ctx: CloudCliContext, baseId: string, ref: string): Promise<Workflow> => {
  const workflow = resolveNamedResource(await listWorkflows(ctx, baseId), ref, "workflow");
  return workflow;
};

export const listWorkflowLaunchers = (ctx: CloudCliContext, workflowId: string): Promise<{ items: GridsWorkflowLauncher[] }> =>
  readApi<{ items: GridsWorkflowLauncher[] }>(ctx, `/workflows/${encodeURIComponent(workflowId)}/launchers`);

const resolveWorkflowLauncher = async (ctx: CloudCliContext, workflow: Workflow, ref: string): Promise<GridsWorkflowLauncher> => {
  const launcher = resolveNamedResource((await listWorkflowLaunchers(ctx, workflow.id)).items, ref, "workflow launcher");
  return launcher;
};

export const emailTemplateRows = (items: EmailTemplate[]) =>
  items.map((template) => ({
    id: template.id,
    name: template.name,
    enabled: template.enabled ? "yes" : "no",
    subject: template.subject,
    updatedAt: template.updatedAt,
  }));

export const workflowRows = (items: Workflow[]) =>
  items.map((workflow) => ({
    id: workflow.id,
    name: workflow.name,
    enabled: workflow.enabled ? "yes" : "no",
    updatedAt: workflow.updatedAt,
  }));

export const workflowLauncherRows = (items: GridsWorkflowLauncher[]) =>
  items.map((launcher) => ({
    id: launcher.id,
    name: launcher.name,
    kind: launcher.config.kind,
    enabled: launcher.enabled ? "yes" : "no",
    revision: launcher.validatedRevision,
    diagnostics: launcher.diagnostics.length,
  }));

export const workflowRunRows = (items: WorkflowRun[]) =>
  items.map((run) => ({
    id: run.id,
    revision: run.workflowRevision,
    channel: run.channel,
    mode: run.mode,
    status: run.status,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt ?? "-",
  }));

/*
 * A step's status is the kernel's step vocabulary, never the run's: a step
 * `completed` or was `planned`, a run `succeeded`. `attempt` counts re-runs of
 * this one step and is 0 on the first — it is not the run's lease generation,
 * which Grids no longer keeps.
 */
export const workflowStepRows = (items: WorkflowStepRun[]) =>
  items.map((step) => ({
    key: step.key,
    path: step.sourcePath.join("."),
    iteration: step.iterationPath.join("."),
    kind: step.kind,
    action: step.action ?? "-",
    status: step.status,
    attempt: step.executionGeneration,
    outcome: step.outcome === null ? "" : JSON.stringify(step.outcome),
  }));

export const workflowEmailRows = (items: WorkflowEmailDelivery[]) =>
  items.map((delivery) => ({
    status: delivery.status,
    subject: delivery.subject ?? "",
    recipients: delivery.recipients.map((recipient) => recipient.recipient).join(", "),
    createdAt: delivery.createdAt,
  }));

export const resolveEmailTemplateFromCommand = async (
  ctx: CloudCliContext,
  args: string[],
  templateRef: string | undefined,
): Promise<{ base: Base; template: EmailTemplate }> => {
  const { base, rest } = await resolveBaseFromCommand(ctx, args, templateRef ? 0 : 1);
  const ref = templateRef ?? requireRestArg(rest, 0, "email template");
  return { base, template: await resolveEmailTemplate(ctx, base.id, ref) };
};

export const resolveWorkflowFromCommand = async (
  ctx: CloudCliContext,
  args: string[],
  workflowRef: string | undefined,
): Promise<{ base: Base; workflow: Workflow }> => {
  const { base, rest } = await resolveBaseFromCommand(ctx, args, workflowRef ? 0 : 1);
  const ref = workflowRef ?? requireRestArg(rest, 0, "workflow");
  return { base, workflow: await resolveWorkflow(ctx, base.id, ref) };
};

export const resolveWorkflowLauncherFromCommand = async (
  ctx: CloudCliContext,
  args: string[],
  workflowRef: string | undefined,
  launcherRef: string | undefined,
): Promise<{ base: Base; workflow: Workflow; launcher: GridsWorkflowLauncher }> => {
  const trailingArgs = (workflowRef ? 0 : 1) + (launcherRef ? 0 : 1);
  const { base, rest } = await resolveBaseFromCommand(ctx, args, trailingArgs);
  const workflowReference = workflowRef ?? requireRestArg(rest, 0, "workflow");
  const launcherReference = launcherRef ?? requireRestArg(rest, workflowRef ? 0 : 1, "workflow launcher");
  const workflow = await resolveWorkflow(ctx, base.id, workflowReference);
  return { base, workflow, launcher: await resolveWorkflowLauncher(ctx, workflow, launcherReference) };
};
