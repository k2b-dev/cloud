import { arg, command, confirmFlag, flag } from "@valentinkolb/cloud/cli";
import type { WorkflowInvocationReceipt } from "@valentinkolb/cloud/workflows";
import type { z } from "zod";
import { PUBLIC_DOCUMENT_PAGE_LIMIT } from "../api/document-public-contracts";
import type { PublicWorkflowDocumentListSchema } from "../api/workflow-public-contracts";
import type { EmailTemplate } from "../contracts";
import {
  type GridsWorkflowLauncher,
  type GridsWorkflowRevisionSummary,
  WORKFLOW_REVISION_HEADER,
  type GridsWorkflow as Workflow,
  type WorkflowAutocompleteResponse,
  type GridsWorkflowRun as WorkflowRun,
} from "../workflows/contracts";
import { documentRows } from "./documents-support";
import { baseArgs, baseFlag, requirePublicId, resolveBaseFromCommand } from "./resources";
import {
  applyDefined,
  JSON_BODY_INPUT,
  jsonRequest,
  type MessageResponse,
  printAutocomplete,
  printCliStructured,
  printDiagnostics,
  printJsonOrMessage,
  printJsonOrTable,
  printReference,
  queryString,
  readApi,
  readJsonInput,
  readTextInput,
  writeApiFile,
} from "./runtime";
import {
  EMAIL_TEMPLATE_REFERENCE,
  emailTemplateFlag,
  emailTemplateRows,
  JSON_BODY_NAMED_INPUT,
  listEmailTemplates,
  listWorkflowLaunchers,
  listWorkflows,
  resolveEmailTemplateFromCommand,
  resolveWorkflow,
  resolveWorkflowFromCommand,
  resolveWorkflowLauncherFromCommand,
  WORKFLOW_INPUTS_INPUT,
  WORKFLOW_LAUNCHER_BODY_INPUT,
  WORKFLOW_REFERENCE,
  WORKFLOW_SOURCE_INPUT,
  type WorkflowEmailDeliveryListResponse,
  type WorkflowRunListResponse,
  type WorkflowStepRunListResponse,
  type WorkflowValidateResponse,
  workflowEmailRows,
  workflowFlag,
  workflowLauncherFlag,
  workflowLauncherRows,
  workflowRows,
  workflowRunRows,
  workflowStepRows,
} from "./workflows-support";

const prettyJson = (value: unknown): string => JSON.stringify(value, null, 2);

export const emailTemplateCommands = [
  command("email-templates reference", {
    summary: "Show workflow email template fields, Liquid data, and examples",
    description: "Use this before creating workflow email templates from an agent.",
    examples: ["cld grids email-templates reference", "cld grids email-templates reference --json"],
    async run({ ctx }) {
      printReference(
        ctx,
        EMAIL_TEMPLATE_REFERENCE,
        [
          "Workflow email templates",
          "",
          "Email templates have Liquid subject and HTML body fields. There is no plain-text fallback field.",
          "",
          "Fields:",
          ...Object.entries(EMAIL_TEMPLATE_REFERENCE.fields).map(([key, value]) => `  ${key}: ${value}`),
          "",
          "Liquid data:",
          ...EMAIL_TEMPLATE_REFERENCE.liquidData.map((item) => `  ${item}`),
          "",
          "Workflow step:",
          `  ${EMAIL_TEMPLATE_REFERENCE.example.step.replace(/\n/g, "\n  ")}`,
        ].join("\n"),
      );
    },
  }),
  command("email-templates list", {
    summary: "List workflow email templates for a base",
    args: baseArgs,
    flags: baseFlag,
    async run({ ctx, args }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const templates = await listEmailTemplates(ctx, base.id);
      printJsonOrTable(ctx, templates, emailTemplateRows(templates), [
        { key: "id", label: "ID" },
        { key: "name", label: "NAME" },
        { key: "enabled", label: "ENABLED" },
        { key: "subject", label: "SUBJECT" },
        { key: "updatedAt", label: "UPDATED" },
      ]);
    },
  }),
  command("email-templates get", {
    summary: "Show a workflow email template",
    args: baseArgs,
    flags: { ...baseFlag, ...emailTemplateFlag },
    async run({ ctx, args, flags }) {
      const { template } = await resolveEmailTemplateFromCommand(ctx, args.args, flags.template);
      if (!printCliStructured(ctx, template)) {
        ctx.print(`${template.name} (${template.id})`);
        if (template.description) ctx.print(template.description);
        ctx.print(`subject: ${template.subject}`);
        ctx.print(`enabled: ${template.enabled ? "yes" : "no"}`);
        ctx.print(`id: ${template.id}`);
        ctx.print("sample data:");
        ctx.print(prettyJson(template.sampleData));
        ctx.print("");
        ctx.print(template.html);
      }
    },
  }),
  command("email-templates create", {
    summary: "Create a workflow email template",
    description: "Run `cld grids email-templates reference` for available fields, Liquid data, and a sendEmail workflow example.",
    args: baseArgs,
    flags: {
      ...baseFlag,
      body: JSON_BODY_INPUT,
      name: flag.string({ description: "Template name" }),
      description: flag.string({ description: "Template description" }),
      subject: flag.string({ description: "Email subject Liquid template" }),
      html: flag.string({ description: "Email HTML Liquid template" }),
      enabled: flag.boolean({ description: "Enable the template" }),
      disabled: flag.boolean({ description: "Create the template disabled" }),
      position: flag.int({ min: 0, description: "Template position" }),
    },
    examples: [
      "cld grids email-templates create Bookshop --name Reminder --subject 'Reminder: {{ data.itemName }}' --html '<p>{{ data.itemName }}</p>'",
      "cld grids email-templates create --base Bookshop --body-file email-template.json",
    ],
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "email template JSON", false)) ?? {};
      applyDefined(body, {
        name: flags.name,
        description: flags.description,
        subject: flags.subject,
        html: flags.html,
        enabled: flags.enabled ? true : flags.disabled ? false : undefined,
        position: flags.position,
      });
      if (!body.name) throw new Error("Missing email template name. Pass --name or --body JSON.");
      if (!body.subject) throw new Error("Missing email template subject. Pass --subject or --body JSON.");
      if (!body.html) throw new Error("Missing email template HTML. Pass --html or --body JSON.");
      const template = await readApi<EmailTemplate>(
        ctx,
        `/email-templates/by-base/${encodeURIComponent(base.id)}`,
        jsonRequest("POST", body),
      );
      printJsonOrMessage(ctx, template, `Created email template ${template.name} (${template.id}).`);
    },
  }),
  command("email-templates update", {
    summary: "Update a workflow email template",
    args: baseArgs,
    flags: {
      ...baseFlag,
      ...emailTemplateFlag,
      body: JSON_BODY_INPUT,
      name: flag.string({ description: "Template name" }),
      description: flag.string({ description: "Template description" }),
      subject: flag.string({ description: "Email subject Liquid template" }),
      html: flag.string({ description: "Email HTML Liquid template" }),
      enabled: flag.boolean({ description: "Enable the template" }),
      disabled: flag.boolean({ description: "Disable the template" }),
      position: flag.int({ min: 0, description: "Template position" }),
    },
    async run({ ctx, args, flags }) {
      const { template } = await resolveEmailTemplateFromCommand(ctx, args.args, flags.template);
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "email template update JSON", false)) ?? {};
      applyDefined(body, {
        name: flags.name,
        description: flags.description,
        subject: flags.subject,
        html: flags.html,
        enabled: flags.enabled ? true : flags.disabled ? false : undefined,
        position: flags.position,
      });
      const updated = await readApi<EmailTemplate>(ctx, `/email-templates/${encodeURIComponent(template.id)}`, jsonRequest("PATCH", body));
      printJsonOrMessage(ctx, updated, `Updated email template ${updated.name} (${updated.id}).`);
    },
  }),
  command("email-templates delete", {
    summary: "Delete a workflow email template",
    args: baseArgs,
    flags: { ...baseFlag, ...emailTemplateFlag, yes: confirmFlag("Delete this email template") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to delete.");
      const { template } = await resolveEmailTemplateFromCommand(ctx, args.args, flags.template);
      await readApi<MessageResponse>(ctx, `/email-templates/${encodeURIComponent(template.id)}`, jsonRequest("DELETE"));
      printJsonOrMessage(ctx, { deleted: template.id }, `Deleted email template ${template.name} (${template.id}).`);
    },
  }),
];

export const workflowCommands = [
  command("workflows reference", {
    summary: "Show workflow YAML, invocation, and launcher JSON reference",
    description: "Use this before creating, invoking, or attaching launchers to workflows from an agent.",
    examples: ["cld grids workflows reference", "cld grids workflows reference --json"],
    async run({ ctx }) {
      printReference(
        ctx,
        WORKFLOW_REFERENCE,
        [
          "Workflows",
          "",
          "Workflow name and description are resource fields. YAML defines inputs, optional automatic triggers, and steps.",
          "Everything that starts a run is an event: grids.invoked for a direct invocation, grids.launcherPressed for a",
          "scanner, bulk, record, or customApp launcher, grids.scheduleTick and grids.recordChanged for the YAML triggers below.",
          "Only schedule and recordEvent are written in YAML; direct and launcher invocation are API/CLI operations.",
          "A dry run is not an event: it is created against the workflow's newest version and plans its effects",
          "instead of performing them.",
          "",
          "Top-level keys:",
          ...WORKFLOW_REFERENCE.language.topLevel.map((item) => `  ${item}`),
          "",
          "Language limits:",
          `  ${prettyJson(WORKFLOW_REFERENCE.language.limits).replace(/\n/g, "\n  ")}`,
          "",
          "Input types and fields:",
          ...WORKFLOW_REFERENCE.language.inputs.flatMap((item) => [
            `  ${item.kind}: ${item.description}`,
            `    value type: ${item.valueType}`,
            `    fields: ${prettyJson(item.config).replace(/\n/g, "\n    ")}`,
          ]),
          "",
          "Automatic triggers and fields:",
          ...WORKFLOW_REFERENCE.language.triggers.flatMap((item) => [
            `  ${item.kind}: ${item.description}`,
            `    event values: ${prettyJson(item.eventValues).replace(/\n/g, "\n    ")}`,
            `    fields: ${prettyJson(item.config).replace(/\n/g, "\n    ")}`,
            ...(item.snippet ? [`    example:\n      ${item.snippet.replace(/\n/g, "\n      ")}`] : []),
          ]),
          "",
          "Actions and fields:",
          ...WORKFLOW_REFERENCE.language.actions.flatMap((item) => [
            `  ${item.kind}: ${item.description}`,
            `    effect: ${item.effect}; dry run: ${item.dryRun}; output: ${item.outputType ?? "none"}`,
            `    fields: ${prettyJson(item.config).replace(/\n/g, "\n    ")}`,
          ]),
          "",
          "Control flow:",
          `  ${WORKFLOW_REFERENCE.language.controlFlow.join(", ")}`,
          "",
          "Direct invocation JSON:",
          `  ${prettyJson(WORKFLOW_REFERENCE.invocation.direct).replace(/\n/g, "\n  ")}`,
          "",
          "Launcher kinds and create JSON:",
          "  scanner: maps scanned text to one record input by stable scan code or a unique field",
          `  ${prettyJson(WORKFLOW_REFERENCE.launchers.scanner).replace(/\n/g, "\n  ")}`,
          `  ${prettyJson(WORKFLOW_REFERENCE.launchers.scannerByField).replace(/\n/g, "\n  ")}`,
          "  bulk: maps explicit recordIds or a Grids record query to one recordList input",
          `  ${prettyJson(WORKFLOW_REFERENCE.launchers.bulk).replace(/\n/g, "\n  ")}`,
          "  explicit bulk: accepts only the exact selected public Record IDs",
          `  ${prettyJson(WORKFLOW_REFERENCE.launchers.explicitBulk).replace(/\n/g, "\n  ")}`,
          "  customApp fixed: runs with saved inputBindings and rejects runtime inputs",
          `  ${prettyJson(WORKFLOW_REFERENCE.launchers.customApp).replace(/\n/g, "\n  ")}`,
          "  customApp prompt: asks for and accepts runtime inputs",
          `  ${prettyJson(WORKFLOW_REFERENCE.launchers.customAppPrompt).replace(/\n/g, "\n  ")}`,
          "",
          "Launcher invocation JSON:",
          "  scanner:",
          `  ${prettyJson(WORKFLOW_REFERENCE.invocation.scanner).replace(/\n/g, "\n  ")}`,
          "  bulk with record IDs:",
          `  ${prettyJson(WORKFLOW_REFERENCE.invocation.bulkRecordIds).replace(/\n/g, "\n  ")}`,
          "Close selection invocation:",
          `  ${prettyJson(WORKFLOW_REFERENCE.invocation.closeSelectionRecordIds).replace(/\n/g, "\n  ")}`,
          "  bulk with query:",
          `  ${prettyJson(WORKFLOW_REFERENCE.invocation.bulkQuery).replace(/\n/g, "\n  ")}`,
          "  customApp:",
          `  ${prettyJson(WORKFLOW_REFERENCE.invocation.customApp).replace(/\n/g, "\n  ")}`,
          "  customApp prompt:",
          `  ${prettyJson(WORKFLOW_REFERENCE.invocation.customAppPrompt).replace(/\n/g, "\n  ")}`,
          "",
          "Workflow YAML example:",
          `  ${WORKFLOW_REFERENCE.example.replace(/\n/g, "\n  ")}`,
          "Close selection YAML:",
          `  ${WORKFLOW_REFERENCE.closeSelectionExample.replace(/\n/g, "\n  ")}`,
        ].join("\n"),
      );
    },
  }),
  command("workflows list", {
    summary: "List workflows visible on a base",
    args: baseArgs,
    flags: baseFlag,
    async run({ ctx, args }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const workflows = await listWorkflows(ctx, base.id);
      printJsonOrTable(ctx, workflows, workflowRows(workflows), [
        { key: "id", label: "ID" },
        { key: "name", label: "NAME" },
        { key: "enabled", label: "ENABLED" },
        { key: "updatedAt", label: "UPDATED" },
      ]);
    },
  }),
  command("workflows get", {
    summary: "Show a workflow",
    args: baseArgs,
    flags: { ...baseFlag, ...workflowFlag },
    async run({ ctx, args, flags }) {
      const { workflow } = await resolveWorkflowFromCommand(ctx, args.args, flags.workflow);
      if (!printCliStructured(ctx, workflow)) {
        ctx.print(`${workflow.name} (${workflow.id})`);
        if (workflow.description) ctx.print(workflow.description);
        ctx.print(`enabled: ${workflow.enabled ? "yes" : "no"}`);
        ctx.print(`id: ${workflow.id}`);
        ctx.print("");
        ctx.print(workflow.source);
      }
    },
  }),
  command("workflows create", {
    summary: "Create a workflow",
    description: "Run `cld grids workflows reference` for YAML structure, triggers, steps, and examples.",
    args: baseArgs,
    flags: {
      ...baseFlag,
      body: JSON_BODY_NAMED_INPUT,
      name: flag.string({ description: "Workflow name" }),
      description: flag.string({ description: "Workflow description" }),
      source: WORKFLOW_SOURCE_INPUT,
      enabled: flag.boolean({ description: "Enable the workflow" }),
      disabled: flag.boolean({ description: "Create the workflow disabled" }),
      position: flag.int({ min: 0, description: "Workflow position" }),
    },
    examples: [
      "cld grids workflows validate Bookshop --source-file workflow.yml",
      "cld grids workflows create Bookshop --name 'Send reminders' --source-file workflow.yml --enabled",
      "cld grids workflows create --base Bookshop --body-file workflow.json",
    ],
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "workflow JSON", false)) ?? {};
      const source = await readTextInput(flags.source, "workflow YAML", false);
      applyDefined(body, {
        name: flags.name,
        description: flags.description,
        source,
        enabled: flags.enabled ? true : flags.disabled ? false : undefined,
        position: flags.position,
      });
      if (!body.name) throw new Error("Missing workflow name. Pass --name or --body JSON.");
      if (!body.source) throw new Error("Missing workflow YAML. Pass --source, --source-file, -f, --stdin, or --body JSON.");
      const workflow = await readApi<Workflow>(ctx, `/workflows/by-base/${encodeURIComponent(base.id)}`, jsonRequest("POST", body));
      printJsonOrMessage(ctx, workflow, `Created workflow ${workflow.name} (${workflow.id}).`);
    },
  }),
  command("workflows update", {
    summary: "Update a workflow",
    args: baseArgs,
    flags: {
      ...baseFlag,
      ...workflowFlag,
      body: JSON_BODY_NAMED_INPUT,
      name: flag.string({ description: "Workflow name" }),
      description: flag.string({ description: "Workflow description" }),
      source: WORKFLOW_SOURCE_INPUT,
      enabled: flag.boolean({ description: "Enable the workflow" }),
      disabled: flag.boolean({ description: "Disable the workflow" }),
      position: flag.int({ min: 0, description: "Workflow position" }),
    },
    async run({ ctx, args, flags }) {
      const { workflow } = await resolveWorkflowFromCommand(ctx, args.args, flags.workflow);
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "workflow update JSON", false)) ?? {};
      const source = await readTextInput(flags.source, "workflow YAML", false);
      applyDefined(body, {
        name: flags.name,
        description: flags.description,
        source,
        enabled: flags.enabled ? true : flags.disabled ? false : undefined,
        position: flags.position,
      });
      const updated = await readApi<Workflow>(
        ctx,
        `/workflows/${encodeURIComponent(workflow.id)}`,
        jsonRequest("PATCH", body, { [WORKFLOW_REVISION_HEADER]: String(workflow.revision) }),
      );
      printJsonOrMessage(ctx, updated, `Updated workflow ${updated.name} (${updated.id}).`);
    },
  }),
  command("workflows history", {
    summary: "List immutable revisions of a workflow",
    args: baseArgs,
    flags: {
      ...baseFlag,
      ...workflowFlag,
      beforeRevision: flag.int({ name: "before-revision", min: 1, description: "List revisions older than this revision" }),
      limit: flag.int({ min: 1, max: 100, description: "Maximum revisions" }),
    },
    async run({ ctx, args, flags }) {
      const { workflow } = await resolveWorkflowFromCommand(ctx, args.args, flags.workflow);
      const payload = await readApi<{ items: GridsWorkflowRevisionSummary[]; nextRevision: number | null }>(
        ctx,
        `/workflows/${encodeURIComponent(workflow.id)}/revisions${queryString({
          beforeRevision: flags.beforeRevision,
          limit: flags.limit,
        })}`,
      );
      printJsonOrTable(
        ctx,
        payload,
        payload.items.map((revision) => ({
          revision: revision.revision,
          name: revision.name,
          actor: revision.actorUserId ?? "-",
          createdAt: revision.createdAt,
        })),
        [
          { key: "revision", label: "REVISION" },
          { key: "name", label: "NAME" },
          { key: "actor", label: "ACTOR" },
          { key: "createdAt", label: "CREATED" },
        ],
      );
      if (ctx.options.output === "text" && payload.nextRevision) ctx.print(`next revision: ${payload.nextRevision}`);
    },
  }),
  command("workflows restore", {
    summary: "Restore an earlier workflow revision as a new revision",
    args: baseArgs,
    flags: {
      ...baseFlag,
      ...workflowFlag,
      revision: flag.int({ min: 1, required: true, description: "Revision to restore" }),
      yes: confirmFlag("Restore this workflow revision"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to restore.");
      const { workflow } = await resolveWorkflowFromCommand(ctx, args.args, flags.workflow);
      const restored = await readApi<Workflow>(
        ctx,
        `/workflows/${encodeURIComponent(workflow.id)}/revisions/${flags.revision}/restore`,
        jsonRequest("POST", { expectedRevision: workflow.revision }),
      );
      printJsonOrMessage(
        ctx,
        restored,
        `Restored workflow ${restored.name} from revision ${flags.revision} as revision ${restored.revision}.`,
      );
    },
  }),
  command("workflows delete", {
    summary: "Delete a workflow",
    args: baseArgs,
    flags: { ...baseFlag, ...workflowFlag, yes: confirmFlag("Delete this workflow") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to delete.");
      const { workflow } = await resolveWorkflowFromCommand(ctx, args.args, flags.workflow);
      await readApi<MessageResponse>(ctx, `/workflows/${encodeURIComponent(workflow.id)}`, jsonRequest("DELETE"));
      printJsonOrMessage(ctx, { deleted: workflow.id }, `Deleted workflow ${workflow.name} (${workflow.id}).`);
    },
  }),
  command("workflows validate", {
    summary: "Validate workflow YAML",
    args: baseArgs,
    flags: { ...baseFlag, source: WORKFLOW_SOURCE_INPUT },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const source = await readTextInput(flags.source, "workflow YAML", true);
      const payload = await readApi<WorkflowValidateResponse>(
        ctx,
        `/workflows/by-base/${encodeURIComponent(base.id)}/validate`,
        jsonRequest("POST", { source }),
      );
      if (printCliStructured(ctx, payload)) return payload.ok ? 0 : 1;
      if (!payload.ok) {
        printDiagnostics(ctx, payload.diagnostics);
        return 1;
      }
      ctx.print("Workflow YAML is valid.");
      return 0;
    },
  }),
  command("workflows autocomplete", {
    summary: "Return permission-safe workflow YAML autocomplete items",
    args: baseArgs,
    flags: {
      ...baseFlag,
      source: WORKFLOW_SOURCE_INPUT,
      caret: flag.int({ min: 0, max: 200_000, description: "UTF-16 caret offset" }),
    },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const source = await readTextInput(flags.source, "workflow YAML", true);
      printAutocomplete(
        ctx,
        await readApi<WorkflowAutocompleteResponse>(
          ctx,
          `/workflows/by-base/${encodeURIComponent(base.id)}/autocomplete`,
          jsonRequest("POST", { source, ...(flags.caret !== undefined ? { caret: flags.caret } : {}) }),
        ),
      );
    },
  }),
  command("workflows invoke", {
    summary: "Invoke a workflow directly through the API",
    description:
      "Records a grids.invoked event, which the workflow is always listening for. Inputs must be a JSON object. The idempotency key is scoped to this workflow: repeating it answers with the run it already started, and reusing it for a different mode, actor, or inputs is rejected as a conflict. A dry run is created against the workflow's newest version instead and plans its effects rather than performing them.",
    args: baseArgs,
    flags: {
      ...baseFlag,
      ...workflowFlag,
      mode: flag.enum(["execute", "dryRun"] as const, {
        default: "execute",
        description: "execute performs the run; dryRun plans it",
      }),
      inputs: WORKFLOW_INPUTS_INPUT,
      idempotencyKey: flag.string({
        name: "idempotency-key",
        required: true,
        description: "Required stable key for this logical invocation",
      }),
      expectedRevision: flag.int({ name: "expected-revision", min: 1, description: "Reject unless this workflow revision is active" }),
    },
    examples: [
      "cld grids workflows invoke Bookshop 'Send reminders' --inputs '{\"email\":\"ada@example.test\"}' --idempotency-key reminder-2026-07-15",
      "cld grids workflows invoke Bookshop 'Send reminders' --mode dryRun --inputs-file inputs.json --idempotency-key reminder-preview-42 --expected-revision 3",
    ],
    async run({ ctx, args, flags }) {
      const { workflow } = await resolveWorkflowFromCommand(ctx, args.args, flags.workflow);
      const inputs = (await readJsonInput<Record<string, unknown>>(flags.inputs, "workflow inputs JSON", false)) ?? {};
      const receipt = await readApi<WorkflowInvocationReceipt>(
        ctx,
        `/workflows/${encodeURIComponent(workflow.id)}/invoke/cli`,
        jsonRequest("POST", {
          mode: flags.mode,
          inputs,
          idempotencyKey: flags.idempotencyKey,
          ...(flags.expectedRevision !== undefined ? { expectedRevision: flags.expectedRevision } : {}),
        }),
      );
      printJsonOrMessage(ctx, receipt, `${receipt.created ? "Created" : "Reused"} workflow run ${receipt.runId} (${receipt.status}).`);
    },
  }),
  command("workflow-launchers list", {
    summary: "List launchers attached to a workflow",
    args: baseArgs,
    flags: { ...baseFlag, ...workflowFlag },
    async run({ ctx, args, flags }) {
      const { workflow } = await resolveWorkflowFromCommand(ctx, args.args, flags.workflow);
      const payload = await listWorkflowLaunchers(ctx, workflow.id);
      printJsonOrTable(ctx, payload, workflowLauncherRows(payload.items), [
        { key: "id", label: "ID" },
        { key: "name", label: "NAME" },
        { key: "kind", label: "KIND" },
        { key: "enabled", label: "ENABLED" },
        { key: "revision", label: "REVISION" },
        { key: "diagnostics", label: "DIAGNOSTICS" },
      ]);
    },
  }),
  command("workflow-launchers create", {
    summary: "Create and validate a workflow launcher",
    description:
      'Pass one JSON object: scanner {"name":"Scan","config":{"kind":"scanner","input":"item","resolve":{"by":"scanCode"}},"enabled":true}; bulk {"name":"Bulk","config":{"kind":"bulk","input":"items"}}; correction {"name":"Create correction","config":{"kind":"record","input":"original","profile":"correctionDraft","intent":"correction"}}; cancellation uses the same Record profile with "intent":"cancellation"; fixed customApp {"name":"Refresh","config":{"kind":"customApp","inputMode":"fixed","inputBindings":{"range":"30d"}}}; prompt customApp {"name":"Run","config":{"kind":"customApp","inputMode":"prompt"}}. Run `cld grids workflows reference` for all shapes.',
    args: baseArgs,
    flags: { ...baseFlag, ...workflowFlag, body: WORKFLOW_LAUNCHER_BODY_INPUT },
    examples: ["cld grids workflow-launchers create Bookshop 'Check in' --body-file launcher.json"],
    async run({ ctx, args, flags }) {
      const { workflow } = await resolveWorkflowFromCommand(ctx, args.args, flags.workflow);
      const body = await readJsonInput<Record<string, unknown>>(flags.body, "workflow launcher JSON", true);
      const launcher = await readApi<GridsWorkflowLauncher>(
        ctx,
        `/workflows/${encodeURIComponent(workflow.id)}/launchers`,
        jsonRequest("POST", body),
      );
      printJsonOrMessage(
        ctx,
        launcher,
        `Created ${launcher.config.kind === "customApp" ? "custom-app" : launcher.config.kind} launcher ${launcher.name} (${launcher.id}).`,
      );
    },
  }),
  command("workflow-launchers update", {
    summary: "Update and revalidate a workflow launcher",
    description:
      'Pass a partial create JSON object, for example {"name":"New label"}, {"enabled":false}, or {"config":{"kind":"bulk","input":"items"}}. Run `cld grids workflows reference` for config shapes.',
    args: baseArgs,
    flags: { ...baseFlag, ...workflowFlag, ...workflowLauncherFlag, body: WORKFLOW_LAUNCHER_BODY_INPUT },
    examples: ["cld grids workflow-launchers update Bookshop 'Check in' Scanner --body '{\"enabled\":false}'"],
    async run({ ctx, args, flags }) {
      const { launcher } = await resolveWorkflowLauncherFromCommand(ctx, args.args, flags.workflow, flags.launcher);
      const body = await readJsonInput<Record<string, unknown>>(flags.body, "workflow launcher update JSON", true);
      const updated = await readApi<GridsWorkflowLauncher>(
        ctx,
        `/workflows/launchers/${encodeURIComponent(launcher.id)}`,
        jsonRequest("PATCH", body),
      );
      printJsonOrMessage(ctx, updated, `Updated ${updated.config.kind} launcher ${updated.name} (${updated.id}).`);
    },
  }),
  command("workflow-launchers delete", {
    summary: "Delete a workflow launcher",
    args: baseArgs,
    flags: {
      ...baseFlag,
      ...workflowFlag,
      ...workflowLauncherFlag,
      yes: confirmFlag("Delete this workflow launcher"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to delete.");
      const { launcher } = await resolveWorkflowLauncherFromCommand(ctx, args.args, flags.workflow, flags.launcher);
      await readApi<null>(ctx, `/workflows/launchers/${encodeURIComponent(launcher.id)}`, jsonRequest("DELETE"));
      printJsonOrMessage(ctx, { deleted: launcher.id }, `Deleted workflow launcher ${launcher.name} (${launcher.id}).`);
    },
  }),
  command("workflow-launchers invoke", {
    summary: "Invoke a scanner, bulk, record, or customApp launcher",
    description:
      'The saved launcher kind selects the endpoint. Pass the exact JSON body: scanner {"operationId":"scan-42","mode":"execute","expectedRevision":3,"scannedText":"gsc_opaque","inputs":{}}; bulk uses either "recordIds":[public-id,...] or "query":{...}; record uses {"operationId":"record-42","mode":"execute","expectedRevision":3,"recordId":"Rec001","inputs":{}}; customApp uses {"operationId":"customApp-42","mode":"execute","expectedRevision":3,"inputs":{...}}. Run `cld grids workflows reference` for complete shapes.',
    args: baseArgs,
    flags: { ...baseFlag, ...workflowFlag, ...workflowLauncherFlag, body: WORKFLOW_LAUNCHER_BODY_INPUT },
    examples: ["cld grids workflow-launchers invoke Bookshop 'Check in' Scanner --body-file invocation.json"],
    async run({ ctx, args, flags }) {
      const { launcher } = await resolveWorkflowLauncherFromCommand(ctx, args.args, flags.workflow, flags.launcher);
      const body = await readJsonInput<Record<string, unknown>>(flags.body, "workflow launcher invocation JSON", true);
      const receipt = await readApi<WorkflowInvocationReceipt>(
        ctx,
        `/workflows/launchers/${encodeURIComponent(launcher.id)}/invoke/${launcher.config.kind === "customApp" ? "custom-app" : launcher.config.kind}`,
        jsonRequest("POST", body),
      );
      printJsonOrMessage(
        ctx,
        receipt,
        `${receipt.created ? "Created" : "Reused"} ${launcher.config.kind === "customApp" ? "custom-app" : launcher.config.kind} workflow run ${receipt.runId} (${receipt.status}).`,
      );
    },
  }),
];

export const workflowRunCommands = [
  command("workflow-runs list", {
    summary: "List workflow runs visible on a base",
    description:
      "Runs of this base's workflows, newest first. --status takes run states only — a run succeeds where a step completes, so see `workflow-runs steps` for the step vocabulary. Use `cld admin workflows` for the kernel-wide view across every app, the event that caused a run, and its effect budget.",
    args: baseArgs,
    flags: {
      ...baseFlag,
      ...workflowFlag,
      status: flag.enum(["queued", "running", "waiting", "succeeded", "failed", "canceled", "needs_attention"] as const, {
        description: "Run state",
      }),
      channel: flag.enum(["api", "customApp", "scanner", "bulk", "schedule", "recordEvent"] as const, {
        description: "What asked for the run",
      }),
      mode: flag.enum(["execute", "dryRun"] as const, { description: "execute performs the run; dryRun plans it" }),
      cursor: flag.string({ description: "Pagination cursor" }),
      limit: flag.int({ min: 1, max: 200, description: "Maximum runs" }),
    },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const workflow = flags.workflow ? await resolveWorkflow(ctx, base.id, flags.workflow) : null;
      const payload = await readApi<WorkflowRunListResponse>(
        ctx,
        `/workflows/by-base/${encodeURIComponent(base.id)}/runs${queryString({
          workflowId: workflow ? workflow.id : undefined,
          status: flags.status,
          channel: flags.channel,
          mode: flags.mode,
          cursor: flags.cursor,
          limit: flags.limit,
        })}`,
      );
      printJsonOrTable(ctx, payload, workflowRunRows(payload.items), [
        { key: "id", label: "ID" },
        { key: "revision", label: "REVISION" },
        { key: "channel", label: "CHANNEL" },
        { key: "mode", label: "MODE" },
        { key: "status", label: "STATUS" },
        { key: "createdAt", label: "CREATED" },
      ]);
      if (ctx.options.output === "text" && payload.nextCursor) ctx.print(`next cursor: ${payload.nextCursor}`);
    },
  }),
  command("workflow-runs get", {
    summary: "Show a workflow run",
    description:
      "Grids' view of the run: which workflow and revision, what asked for it, and how it ended. `cld admin workflows show <run-id>` adds the kernel's side — the event that caused it, its effect budget, and any child runs.",
    args: { run: arg.required({ description: "Workflow run public id" }) },
    async run({ ctx, args }) {
      const run = await readApi<WorkflowRun>(ctx, `/workflows/runs/${encodeURIComponent(requirePublicId(args.run, "Workflow run id"))}`);
      if (!printCliStructured(ctx, run)) {
        ctx.print(`${run.id} (${run.status})`);
        ctx.print(`workflow: ${run.workflowId ?? "-"}`);
        ctx.print(`launcher: ${run.launcherId ?? "-"}`);
        ctx.print(`revision: ${run.workflowRevision}`);
        ctx.print(`channel: ${run.channel}`);
        ctx.print(`mode: ${run.mode}`);
        if (run.resultMessage) ctx.print(`message: ${run.resultMessage}`);
        if (run.error) {
          ctx.print(`error: ${run.error.code}: ${run.error.message}`);
          ctx.print(`retryable: ${run.error.retryable ? "yes" : "no"}`);
          if (run.error.details) ctx.print(`details: ${JSON.stringify(run.error.details)}`);
        }
      }
    },
  }),
  command("workflow-runs cancel", {
    summary: "Cancel a queued, running, or waiting workflow run",
    description:
      "A request, not a write: a queued run is canceled at once, while a running or waiting one stops when the worker holding it next checks in. It never undoes an effect that already happened.",
    args: { run: arg.required({ description: "Workflow run public id" }) },
    flags: { yes: confirmFlag("Cancel this workflow run") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to cancel.");
      const run = await readApi<WorkflowRun>(
        ctx,
        `/workflows/runs/${encodeURIComponent(requirePublicId(args.run, "Workflow run id"))}/cancel`,
        jsonRequest("POST", {}),
      );
      printJsonOrMessage(
        ctx,
        run,
        run.status === "canceled"
          ? `Canceled workflow run ${run.id}.`
          : `Requested cancellation of workflow run ${run.id}; it is still ${run.status}.`,
      );
    },
  }),
  command("workflow-runs steps", {
    summary: "List workflow run steps",
    description:
      "A step has its own vocabulary, not the run's: STATUS is running, completed, waiting, failed, needs_attention, terminal, planned, unsupported, indeterminate, or canceled. A step completes where a run succeeds, and a dry run records planned steps. ATTEMPT counts re-runs of that one step and is 0 the first time.",
    args: { run: arg.required({ description: "Workflow run public id" }) },
    async run({ ctx, args }) {
      const payload = await readApi<WorkflowStepRunListResponse>(
        ctx,
        `/workflows/runs/${encodeURIComponent(requirePublicId(args.run, "Workflow run id"))}/steps`,
      );
      printJsonOrTable(ctx, payload, workflowStepRows(payload.items), [
        { key: "key", label: "KEY" },
        { key: "path", label: "PATH" },
        { key: "iteration", label: "ITERATION" },
        { key: "kind", label: "KIND" },
        { key: "action", label: "ACTION" },
        { key: "status", label: "STATUS" },
        { key: "attempt", label: "ATTEMPT" },
        { key: "outcome", label: "OUTCOME" },
      ]);
      if (ctx.options.output === "text" && payload.truncated) ctx.print(`showing the first ${payload.items.length} steps`);
    },
  }),
  command("workflow-runs documents", {
    summary: "List documents generated by a workflow run",
    args: { run: arg.required({ description: "Workflow run public id" }) },
    flags: {
      limit: flag.int({ min: 1, max: PUBLIC_DOCUMENT_PAGE_LIMIT, description: "Maximum documents" }),
      offset: flag.int({ min: 0, description: "Document offset" }),
    },
    async run({ ctx, args, flags }) {
      const payload = await readApi<z.infer<typeof PublicWorkflowDocumentListSchema>>(
        ctx,
        `/workflows/runs/${encodeURIComponent(requirePublicId(args.run, "Workflow run id"))}/documents${queryString({ limit: flags.limit, offset: flags.offset })}`,
      );
      printJsonOrTable(ctx, payload, documentRows(payload.items), [
        { key: "id", label: "ID" },
        { key: "number", label: "NUMBER" },
        { key: "filename", label: "FILENAME" },
        { key: "tags", label: "TAGS" },
        { key: "createdAt", label: "CREATED" },
      ]);
    },
  }),
  command("workflow-runs download-documents", {
    summary: "Download all documents generated by a workflow run as one PDF",
    args: { run: arg.required({ description: "Workflow run public id" }) },
    flags: { out: flag.string({ description: "Output PDF path" }) },
    async run({ ctx, args, flags }) {
      await writeApiFile(
        ctx,
        `/workflows/runs/${encodeURIComponent(requirePublicId(args.run, "Workflow run id"))}/documents/download`,
        undefined,
        flags.out,
      );
    },
  }),
];

export const workflowEmailCommands = [
  command("workflow-emails list", {
    summary: "List workflow email deliveries visible on a base",
    args: baseArgs,
    flags: {
      ...baseFlag,
      ...workflowFlag,
      cursor: flag.string({ description: "Pagination cursor" }),
      limit: flag.int({ min: 1, max: 200, description: "Maximum deliveries" }),
    },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const workflow = flags.workflow ? await resolveWorkflow(ctx, base.id, flags.workflow) : null;
      const payload = await readApi<WorkflowEmailDeliveryListResponse>(
        ctx,
        `/workflows/by-base/${encodeURIComponent(base.id)}/email-deliveries${queryString({
          workflowId: workflow ? workflow.id : undefined,
          cursor: flags.cursor,
          limit: flags.limit,
        })}`,
      );
      printJsonOrTable(ctx, payload, workflowEmailRows(payload.items), [
        { key: "status", label: "STATUS" },
        { key: "subject", label: "SUBJECT" },
        { key: "recipients", label: "RECIPIENTS" },
        { key: "createdAt", label: "CREATED" },
      ]);
      if (ctx.options.output === "text" && payload.nextCursor) ctx.print(`next cursor: ${payload.nextCursor}`);
    },
  }),
];
