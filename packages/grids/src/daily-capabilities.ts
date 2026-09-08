import { createHash } from "node:crypto";
import { err, fail, ok } from "@k2b/stdlib";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CapabilityExecutionContext,
  capabilityPage,
  defineCapabilities,
} from "@valentinkolb/cloud/contracts";
import { get as settingsGet } from "@valentinkolb/cloud/services/settings";
import { normalizeTimeZone } from "@valentinkolb/cloud/shared";
import { z } from "zod";
import { PublicDocumentSchema } from "./api/document-public-contracts";
import { documentActor, loadTemplateAndTable, projectDocuments } from "./api/documents-api-shared";
import { actorViewerFor, gateBaseAtAccess, workflowPrincipalFor } from "./api/permissions";
import { toPublicWorkflowReceipt } from "./api/workflow-api-shared";
import { PublicWorkflowInvocationReceiptSchema } from "./api/workflow-public-contracts";
import { capabilityMessagesFor } from "./capability-messages";
import { ShortIdSchema } from "./contracts";
import { gridsService } from "./service";
import { decodeDocumentCursor } from "./service/document-values";
import { projectPublicId, resolvePublicId } from "./service/public-resources";
import { admitRecordLauncher, invokeRecordLauncher } from "./service/workflow-launcher-invocations";
import { listLaunchersForBase } from "./service/workflow-launchers";
import { getWorkflowRunByShortId } from "./service/workflow-runs";
import { correctionDraftIntent } from "./workflows/contracts";

const readInput = z
  .object({ id: ShortIdSchema.describe("Public ID from the corresponding discovery result or resource reference.") })
  .strict();
const pageInput = {
  offset: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 21)
    .default(0)
    .describe("Next offset from discovery; zero for the first page."),
  limit: z.number().int().min(1).max(20).default(10).describe("Maximum candidates inspected on this page."),
};
const documentData = PublicDocumentSchema.omit({ tags: true, createdBy: true }).strip();
const templateData = z.object({ id: ShortIdSchema, tableId: ShortIdSchema, name: z.string(), enabled: z.boolean() }).strict();
const recordActionInput = z
  .object({
    launcherId: ShortIdSchema.describe("Record action ID from workflow.record-actions."),
    recordId: ShortIdSchema.describe("Record public ID from the returned table, obtained with GQL."),
    expectedRevision: z.number().int().positive().describe("Revision returned by workflow.record-actions; changes require new approval."),
  })
  .strict();
const createInput = z
  .object({
    templateId: ShortIdSchema.describe("Enabled template public ID from document.templates."),
    recordId: ShortIdSchema.describe("Record public ID from the template table, obtained with GQL."),
  })
  .strict();
const actionData = z
  .object({
    id: ShortIdSchema,
    name: z.string(),
    tableId: ShortIdSchema,
    expectedRevision: z.number().int().positive(),
    intent: z.enum(["correction", "cancellation"]),
  })
  .strict();
const runData = z.object({ id: ShortIdSchema, status: z.string(), mode: z.string() }).strict();
const missing = () => fail(err.notFound("Resource"));
const dateConfig = async (context: CapabilityExecutionContext) => ({
  timeZone: normalizeTimeZone(String((await settingsGet<string>("app.timezone")) || "").trim(), "UTC"),
  locale: context.locale ?? "en",
  firstDayOfWeek: 1 as const,
});
const operationKey = (context: CapabilityExecutionContext, action: string) =>
  createHash("sha256")
    .update(JSON.stringify(["grids.capability", action, context.accessSubject, context.idempotencyKey]))
    .digest("hex");
const documentResult = async (document: Parameters<typeof projectDocuments>[0][number]) => {
  const [value] = await projectDocuments([document]);
  return {
    data: documentData.parse(value),
    refs: [{ type: "grids.document", id: document.shortId }],
    links: [{ rel: "open" as const, href: `/api/grids/documents/${document.shortId}/artifacts/pdf` }],
  };
};
const loadIssuance = async (input: z.infer<typeof createInput>, context: CapabilityExecutionContext) => {
  const loaded = await loadTemplateAndTable(input.templateId);
  if (!loaded) return missing();
  const gate = await gateBaseAtAccess(context, loaded.table.baseId, "write");
  if (!gate.ok) return gate;
  if (!loaded.template.enabled) return fail(err.badInput(capabilityMessagesFor(context.locale).documentTemplateDisabled));
  const recordId = await resolvePublicId("record", input.recordId);
  const record = recordId
    ? await gridsService.record.get(loaded.table.id, recordId, { viewer: actorViewerFor(context), dateConfig: await dateConfig(context) })
    : null;
  return record ? ok({ ...loaded, record }) : missing();
};
const loadRecordAction = async (input: z.infer<typeof recordActionInput>, context: CapabilityExecutionContext) => {
  const launcherId = await resolvePublicId("workflowLauncher", input.launcherId);
  if (!launcherId) return missing();
  const principal = workflowPrincipalFor(context);
  const allowed = await admitRecordLauncher({ launcherId, expectedRevision: input.expectedRevision, principal, locale: context.locale });
  if (!allowed.ok) return allowed;
  const launcher = await gridsService.workflow.launcher.get(launcherId);
  if (!launcher || launcher.config.kind !== "record") return missing();
  const workflow = await gridsService.workflow.get(launcher.workflowId);
  const tableId = workflow?.plan.bindings[`inputs.${launcher.config.input}.table`];
  if (typeof tableId !== "string") return missing();
  const recordId = await resolvePublicId("record", input.recordId);
  const record = recordId
    ? await gridsService.record.get(tableId, recordId, { viewer: actorViewerFor(context), dateConfig: await dateConfig(context) })
    : null;
  return record ? ok({ launcher, record, principal }) : missing();
};

export const dailyCapabilities = defineCapabilities({
  protocolVersion: 1,
  types: {
    document: { title: "Grids Document", description: "One stored immutable document and its artifact metadata.", reader: "document.read" },
    "workflow-run": { title: "Grids Workflow Run", description: "Status of one accepted workflow operation.", reader: "workflow.run.read" },
  },
  queries: {
    "document.templates": {
      title: "Find document templates",
      description:
        "Discover templates for a table from gql.context. Use an enabled template ID and a record from that table with document.create or document.list.",
      input: z.object({ tableId: ShortIdSchema.describe("Table public ID from gql.context."), ...pageInput }).strict(),
      data: z.object({ items: z.array(templateData), nextOffset: z.number().nullable() }).strict(),
      openWorld: false,
      async run(input, context) {
        const table = await gridsService.table.getByShortId(input.tableId);
        if (!table) return missing();
        const gate = await gateBaseAtAccess(context, table.baseId, "read");
        if (!gate.ok) return gate;
        const rows = await gridsService.document.listTemplatesForTable(table.id, { limit: input.limit + 1, offset: input.offset });
        return ok({
          data: {
            items: rows
              .slice(0, input.limit)
              .map((item) => ({ id: item.shortId, tableId: input.tableId, name: item.name, enabled: item.enabled })),
            nextOffset: rows.length > input.limit ? input.offset + input.limit : null,
          },
        });
      },
    },
    "document.list": {
      title: "Find stored documents",
      description:
        "Read a bounded page of immutable documents for a template from document.templates. Follow document refs with document.read. Does not render or issue documents.",
      input: z
        .object({
          templateId: ShortIdSchema.describe("Template public ID from document.templates."),
          cursor: z.string().max(2000).optional().describe("Opaque cursor from the previous page."),
          limit: pageInput.limit,
        })
        .strict(),
      data: z.array(documentData),
      openWorld: false,
      async run(input, context) {
        const loaded = await loadTemplateAndTable(input.templateId);
        if (!loaded) return missing();
        const gate = await gateBaseAtAccess(context, loaded.table.baseId, "read");
        if (!gate.ok) return gate;
        if (input.cursor && !decodeDocumentCursor(input.cursor))
          return fail(err.badInput(capabilityMessagesFor(context.locale).invalidDocumentCursor));
        const page = await gridsService.document.listDocumentsForTemplate({
          templateId: loaded.template.id,
          limit: input.limit,
          cursor: input.cursor ?? null,
        });
        const data = (await projectDocuments(page.items)).map((item) => documentData.parse(item));
        if (Buffer.byteLength(JSON.stringify(data)) > CAPABILITY_MAX_RESULT_BYTES - 32768)
          return fail(err.badInput(capabilityMessagesFor(context.locale).fewerDocuments));
        return ok({
          data,
          refs: data.map((item) => ({ type: "grids.document", id: item.id })),
          page: capabilityPage(page.nextCursor ?? undefined),
        });
      },
    },
    "document.read": {
      title: "Read stored document",
      description:
        "Read metadata and artifact hashes for a grids.document ref from document.list or document.create. The authenticated download link returns stored PDF bytes, not a new rendering.",
      input: readInput,
      data: documentData,
      openWorld: false,
      async run(input, context) {
        const document = await gridsService.document.getDocumentByShortId(input.id);
        if (!document) return missing();
        const gate = await gateBaseAtAccess(context, document.baseId, "read");
        return gate.ok ? ok(await documentResult(document)) : gate;
      },
    },
    "workflow.record-actions": {
      title: "Find record workflow actions",
      description:
        "Discover configured correction/cancellation Draft actions in a Base from base.list. Pages may be empty after permission/revision filtering; follow nextOffset. Use the returned table with GQL to find a finalized original, then workflow.record-action.",
      input: z.object({ baseId: ShortIdSchema.describe("Base public ID from base.list."), ...pageInput }).strict(),
      data: z.object({ items: z.array(actionData), nextOffset: z.number().nullable() }).strict(),
      openWorld: false,
      async run(input, context) {
        const base = await gridsService.base.getByShortId(input.baseId);
        if (!base) return missing();
        const gate = await gateBaseAtAccess(context, base.id, "read");
        if (!gate.ok) return gate;
        const candidates = await listLaunchersForBase(base.id, true, { limit: input.limit + 1, offset: input.offset });
        const items: z.infer<typeof actionData>[] = [];
        for (const launcher of candidates.slice(0, input.limit)) {
          if (launcher.config.kind !== "record") continue;
          const allowed = await admitRecordLauncher({
            launcherId: launcher.id,
            expectedRevision: launcher.validatedRevision,
            principal: workflowPrincipalFor(context),
            locale: context.locale,
          });
          if (!allowed.ok) continue;
          const workflow = await gridsService.workflow.get(launcher.workflowId);
          const internalTable = workflow?.plan.bindings[`inputs.${launcher.config.input}.table`];
          const tableId = typeof internalTable === "string" ? await projectPublicId("table", internalTable) : null;
          if (tableId)
            items.push({
              id: launcher.shortId,
              name: launcher.name,
              tableId,
              expectedRevision: launcher.validatedRevision,
              intent: correctionDraftIntent(launcher.config),
            });
        }
        return ok({ data: { items, nextOffset: candidates.length > input.limit ? input.offset + input.limit : null } });
      },
    },
    "workflow.run.read": {
      title: "Read workflow run status",
      description:
        "Read the current status of a grids.workflow-run ref returned by workflow.record-action. Requires Base read access; no raw inputs, results or internal event payloads are returned.",
      input: readInput,
      data: runData,
      openWorld: false,
      async run(input, context) {
        const run = await getWorkflowRunByShortId(input.id);
        const workflow = run?.workflowId ? await gridsService.workflow.get(run.workflowId, true) : null;
        if (!run || !workflow) return missing();
        const gate = await gateBaseAtAccess(context, workflow.baseId, "read");
        return gate.ok
          ? ok({ data: { id: input.id, status: run.status, mode: run.mode }, refs: [{ type: "grids.workflow-run", id: input.id }] })
          : gate;
      },
    },
  },
  actions: {
    "document.create": {
      title: "Issue an immutable document",
      description:
        "Issue one document from document.templates and a Record. This may assign an irreversible invoice/document number. Review every issuance; reuse the capability idempotency key only for retries of the same request. No compliance guarantee or external delivery.",
      input: createInput,
      data: documentData,
      destructive: true,
      openWorld: false,
      idempotency: "required",
      async review(input, context) {
        const loaded = await loadIssuance(input, context);
        if (!loaded.ok) return loaded;
        return ok({
          message: capabilityMessagesFor(context.locale).issueDocumentReview,
          details: [
            { label: capabilityMessagesFor(context.locale).template, value: loaded.data.template.name },
            { label: capabilityMessagesFor(context.locale).record, value: input.recordId },
          ],
        });
      },
      async run(input, context) {
        if (!context.idempotencyKey) return fail(err.badInput(capabilityMessagesFor(context.locale).idempotencyRequired));
        const loaded = await loadIssuance(input, context);
        if (!loaded.ok) return loaded;
        const result = await gridsService.document.createDocumentForRecord({
          ...loaded.data,
          recordId: loaded.data.record.id,
          actor: documentActor(context.actor),
          idempotencyKey: operationKey(context, "document.create"),
          viewer: actorViewerFor(context),
          dateConfig: await dateConfig(context),
          canReadTable: async (target) => (await gateBaseAtAccess(context, target.baseId, "read")).ok,
        });
        return result.ok ? ok(await documentResult(result.data)) : result;
      },
    },
    "workflow.record-action": {
      title: "Run a record workflow action",
      description:
        "Create one linked correction/cancellation Draft through an action from workflow.record-actions at its exact revision. The original must be finalized and remains unchanged. No issuance or external delivery. Obtain explicit approval; no arbitrary workflow source or extra inputs. Follow the run ref for status.",
      input: recordActionInput,
      data: PublicWorkflowInvocationReceiptSchema,
      destructive: true,
      openWorld: false,
      idempotency: "required",
      async review(input, context) {
        const loaded = await loadRecordAction(input, context);
        if (!loaded.ok) return loaded;
        return ok({
          message: capabilityMessagesFor(context.locale).recordActionReview,
          details: [
            { label: capabilityMessagesFor(context.locale).action, value: loaded.data.launcher.name },
            { label: capabilityMessagesFor(context.locale).record, value: input.recordId },
            { label: capabilityMessagesFor(context.locale).revision, value: String(input.expectedRevision) },
          ],
        });
      },
      async run(input, context) {
        if (!context.idempotencyKey) return fail(err.badInput(capabilityMessagesFor(context.locale).idempotencyRequired));
        const loaded = await loadRecordAction(input, context);
        if (!loaded.ok) return loaded;
        const result = await invokeRecordLauncher({
          launcherId: loaded.data.launcher.id,
          recordId: loaded.data.record.id,
          expectedRevision: input.expectedRevision,
          principal: loaded.data.principal,
          locale: context.locale,
          operationId: operationKey(context, "workflow.record-action"),
          mode: "execute",
        });
        if (!result.ok) return result;
        const data = await toPublicWorkflowReceipt(result.data);
        return ok({ data, refs: [{ type: "grids.workflow-run", id: data.runId }] });
      },
    },
  },
});
