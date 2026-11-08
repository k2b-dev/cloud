import { sql } from "@k2b/cloud";
import { BLOCK_LIMITS, BlockViewSchema, bindView, validateBlocks } from "@k2b/cloud/blocks";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CapabilityActionReview,
  type CapabilityExecutionContext,
  CloudResourceReaderViewSchema,
  type CloudResourceReference,
  type CloudResourceView,
  capabilityPage,
  defineCapabilities,
  UniversalSearchDataSchema,
  type UniversalSearchInput,
  UniversalSearchInputSchema,
} from "@k2b/cloud/contracts";
import { get as settingsGet } from "@k2b/cloud/services/settings";
import { normalizeTimeZone } from "@k2b/cloud/shared";
import { err, fail, ok } from "@k2b/stdlib";
import { z } from "zod";
import { DocumentCapabilityDataSchema, documentArtifactDownloadUrl, documentDownloadUrl } from "./api/document-public-contracts";
import { documentActor, loadTemplateAndTable, projectDocuments } from "./api/documents-api-shared";
import { fileResponse } from "./api/download-response";
import { publicGqlParameterContext } from "./api/gql-public";
import {
  buildPermissionedGqlResolverContextForAccess,
  canonicalGqlSourceForContext,
  emptyDslAst,
  executeGqlSourceForContext,
  executeSavedViewSourceForContext,
  type GridsGqlRuntimeContext,
} from "./api/gql-runtime";
import {
  accessActorUser,
  actorViewerFor,
  type GridsAccessContext,
  gateBaseAtAccess,
  gateCredentialScopeFor,
  resourceBoundBaseIdFor,
  workflowPrincipalFor,
} from "./api/permissions";
import { isQueryAdmissionError } from "./api/query-admission";
import { PublicRecordFinalizationReadinessSchema, toPublicRecordFinalizationReadiness } from "./api/record-finalization";
import { toPublicWorkflowReceipt } from "./api/workflow-api-shared";
import { PublicWorkflowInvocationReceiptSchema } from "./api/workflow-public-contracts";
import { gridsEvents } from "./app-events";
import {
  BaseCapabilityDataSchema,
  BaseListDataSchema,
  BaseListInputSchema,
  BaseReadInputSchema,
  GqlContextDataSchema,
  GqlContextInputSchema,
  type GqlContextItemSchema,
  GqlExecuteInputSchema,
  GqlPreviewInputSchema,
  GqlResultDataSchema,
  GqlViewExecuteInputSchema,
  RecordCapabilityDataSchema,
  RecordCreateInputSchema,
  RecordExternalUpsertDataSchema,
  RecordExternalUpsertInputSchema,
  RecordReadInputSchema,
  RecordUpdateInputSchema,
  TableCapabilityDataSchema,
  TableReadInputSchema,
  ViewCapabilityDataSchema,
  ViewCreateInputSchema,
  ViewReadInputSchema,
} from "./capability-contracts";
import { externalUpsertRequestHash, capabilityOperationKey as operationKey } from "./capability-idempotency";
import { capabilityMessagesFor } from "./capability-messages";
import { gridsCapabilityPresentation } from "./capability-presentation";
import { DslQueryExecuteBodySchema, type DslQueryPreviewResponse, ShortIdSchema } from "./contracts";
import { isRecordWritableFieldType } from "./field-types";
import { ObjectListConfigSchema } from "./field-types/object-list";
import {
  AtomicRecordsDataSchema,
  AtomicRecordsInputSchema,
  CorrectionDraftInputSchema,
  FinalizeRecordInputSchema,
  IntegrityRecordDataSchema,
  RecordTargetSchema,
} from "./integrity-contracts";
import { gridsActionReview } from "./integrity-review";
import { queryCapabilityHref } from "./query-capability-link";
import { parseGridsQueryDsl } from "./query-dsl/parser";
import { gridsService } from "./service";
import { withCapabilityAudit } from "./service/audit";
import { MAX_DOCUMENT_ARTIFACT_BYTES } from "./service/document-artifact-drafts";
import { persistDocumentData, resolveDocumentData } from "./service/document-data";
import { documentIssuanceService } from "./service/document-issuance";
import { DocumentQueryOutputSchema } from "./service/document-query-output";
import { DocumentSourceVersionsInputSchema } from "./service/document-source-versions";
import { decodeDocumentCursor } from "./service/document-values";
import { toPublicGqlResponse } from "./service/gql-public-result";
import { buildTrustedGqlResolverContext } from "./service/gql-resolver-context";
import { projectPublicId, resolvePublicId, resolvePublicIds } from "./service/public-resources";
import { bindQueryData, captureQueryData } from "./service/query-capture";
import { inspect } from "./service/record-finalization";
import {
  changeRecordsAtomically,
  createCorrectionDraft,
  finalizeRecord,
  type IntegrityContext,
  integrityAttempt,
} from "./service/record-integrity";
import { buildRelationLabelCacheForIds } from "./service/relation-labels";
import type { Base, Field, GridRecord, Table } from "./service/types";
import { admitRecordLauncher, invokeRecordLauncher } from "./service/workflow-launcher-invocations";
import { listLaunchersForBase } from "./service/workflow-launchers";
import { getWorkflowRunByShortId } from "./service/workflow-runs";
import { correctionDraftIntent } from "./workflows/contracts";

export const DocumentCaptureDataSchema = z
  .object({
    id: ShortIdSchema.describe("Public immutable document capture ID."),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe("Digest returned by document.capture."),
    rowCount: z.number().int().nonnegative().max(10000).describe("Complete captured row count."),
    capturedAt: z.iso.datetime().describe("Capture timestamp returned by document.capture."),
  })
  .strict();

const text = (context: CapabilityExecutionContext, en: string, de: string) => (context.locale?.startsWith("de") ? de : en);
const integrityContext = async (context: CapabilityExecutionContext): Promise<IntegrityContext> => ({
  ...context,
  dateConfig: {
    timeZone: normalizeTimeZone(String((await settingsGet<string>("app.timezone")) || "").trim(), "UTC"),
    locale: context.locale ?? "en",
    firstDayOfWeek: 1,
  },
});
const base = async (id: string, context: CapabilityExecutionContext, client = sql) => {
  const [row] = await client<Array<{ id: string }>>`SELECT id::text FROM grids.bases WHERE short_id = ${id} AND deleted_at IS NULL`;
  if (!row) throw err.notFound("Base");
  const access = await gateBaseAtAccess(context, row.id, "write", client);
  if (!access.ok) throw access.error;
  return row.id;
};
const authorizer = (baseId: string, context: CapabilityExecutionContext) => async (ids: readonly string[], client: typeof sql) => {
  context.signal.throwIfAborted();
  const access = await gateBaseAtAccess(context, baseId, "write", client);
  if (!access.ok) throw access.error;
  for (const id of ids) {
    const [table] = await client<
      Array<{ id: string }>
    >`SELECT t.id::text FROM grids.tables t JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL WHERE t.id = ${id}::uuid AND t.base_id = ${baseId}::uuid AND t.deleted_at IS NULL`;
    if (!table)
      throw err.forbidden(
        text(context, "Document source is unavailable in this Base.", "Die Dokumentquelle ist in dieser Base nicht verfügbar."),
      );
  }
};
const captureInput = z
  .object({
    query: DslQueryExecuteBodySchema.shape.query.describe(
      "GQL query; captures its complete result, at most 10,000 rows within the document data budget.",
    ),
  })
  .strict();
const issueInput = z
  .object({
    data: DocumentCaptureDataSchema.describe("Immutable capture from document.capture."),
    output: DocumentQueryOutputSchema.describe("Versioned output definition: PDF, CSV, JSON, XML, ZIP, DATEV or SEPA."),
    sourceVersions: DocumentSourceVersionsInputSchema.optional().describe(
      "Current source Record versions; data uses the captured versions. Required for financial exports.",
    ),
    filename: z.string().trim().min(1).max(255).optional().describe("Optional output filename."),
    tags: z.array(z.string().trim().min(1)).max(20).default([]).describe("Up to 20 document tags."),
  })
  .strict();
const confirmationInput = z
  .object({
    receiptId: ShortIdSchema.describe("Pending receipt from document.issue."),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe("Exact confirmation digest from document.issue; changed data requires another confirmation."),
  })
  .strict();
const issueData = z.discriminatedUnion("state", [
  z.object({ state: z.literal("issued"), document: DocumentCapabilityDataSchema }).strict(),
  z.object({ state: z.literal("confirmationRequired"), receiptId: ShortIdSchema, sha256: z.string() }).strict(),
]);
const reviewed = (context: CapabilityExecutionContext, en: string, de: string, input: unknown) =>
  ok(gridsActionReview(context, text(context, en, de), input));
const finalizeReview = (input: Omit<z.infer<typeof FinalizeRecordInputSchema>, "tableId">, context: CapabilityExecutionContext) =>
  reviewed(
    context,
    "Close the current Record under its pinned finalization policy. Four-eyes approval remains required.",
    "Den aktuellen Datensatz nach der festgehaltenen Abschlussregel abschließen. Die Vier-Augen-Freigabe bleibt erforderlich.",
    input,
  );
const confirmationRequest = async (input: z.infer<typeof confirmationInput>, context: CapabilityExecutionContext) => {
  const baseId = await base(context.target?.id ?? "", context);
  return {
    baseId,
    runId: null,
    receiptId: input.receiptId,
    actor: documentActor(context.actor),
    locale: context.locale,
    authorize: authorizer(baseId, context),
  };
};

export const integrityCapabilities = defineCapabilities({
  protocolVersion: 2,
  queries: {
    "record.finalization.read": {
      title: "Read Record finalization readiness",
      description: "Read current requirements, Four-eyes request and policy revision before closing or finalizing a Record.",
      target: "table",
      input: RecordTargetSchema.omit({ tableId: true }),
      data: PublicRecordFinalizationReadinessSchema,
      openWorld: false,
      run: (input, context) =>
        integrityAttempt(async () => {
          const tableId = await resolvePublicId("table", context.target?.id ?? "");
          const recordId = await resolvePublicId("record", input.recordId);
          if (!tableId || !recordId) return fail(err.notFound("Record"));
          const [table] = await sql<
            Array<{ base_id: string }>
          >`SELECT base_id::text FROM grids.tables WHERE id = ${tableId}::uuid AND deleted_at IS NULL`;
          if (!table) return fail(err.notFound("Table"));
          const allowed = await gateBaseAtAccess(context, table.base_id, "read");
          if (!allowed.ok) return allowed;
          const result = await inspect({ tableId, recordId, actorId: accessActorUser(context)?.id ?? null, locale: context.locale });
          return result.ok ? ok({ data: await toPublicRecordFinalizationReadiness(result.data) }) : result;
        }),
    },
  },
  actions: {
    "record.atomic": {
      title: "Change Records atomically",
      description:
        "Create/update up to 50 Records in one Base transaction after current-state checks; at most 100 locked Records. Any failure rolls back every change. Requires ordinary Base write access.",
      target: "base",
      input: AtomicRecordsInputSchema.omit({ baseId: true }),
      data: AtomicRecordsDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      policy: { silent: "shared" },
      review: (input, context) => reviewed(context, "Change these Records atomically", "Diese Datensätze atomar ändern", input),
      run: (input, context) =>
        withCapabilityAudit(context, async () => {
          const result = await changeRecordsAtomically({ ...input, baseId: context.target?.id ?? "" }, await integrityContext(context));
          return result.ok
            ? ok({ data: result.data, refs: result.data.records.map((row) => ({ type: "grids.record", id: row.id })) })
            : result;
        }),
    },
    "record.close": {
      title: "Close Record",
      description:
        "Finalize under Direct policy or create a Four-eyes request. Requires current Record version and finalization policy revision. Always asks.",
      target: "table",
      input: FinalizeRecordInputSchema.omit({ tableId: true }),
      data: IntegrityRecordDataSchema.extend({ state: z.enum(["requested", "finalized"]) }),
      destructive: true,
      openWorld: false,
      idempotency: "required",
      policy: { ask: "cannot_undo" },
      review: finalizeReview,
      run: (input, context) =>
        withCapabilityAudit(context, async () => {
          const result = await finalizeRecord({ ...input, tableId: context.target?.id ?? "" }, await integrityContext(context), true);
          return result.ok ? ok({ data: result.data }) : result;
        }),
    },
    "record.finalize": {
      title: "Finalize Record",
      description:
        "Finalize one version-checked Record without changing the original Four-eyes rules. An independent eligible person must approve an existing request. Always asks.",
      target: "table",
      input: FinalizeRecordInputSchema.omit({ tableId: true }),
      data: IntegrityRecordDataSchema.extend({ state: z.enum(["requested", "finalized"]) }),
      destructive: true,
      openWorld: false,
      idempotency: "required",
      policy: { ask: "cannot_undo" },
      review: finalizeReview,
      run: (input, context) =>
        withCapabilityAudit(context, async () => {
          const result = await finalizeRecord({ ...input, tableId: context.target?.id ?? "" }, await integrityContext(context));
          return result.ok ? ok({ data: result.data }) : result;
        }),
    },
    "record.correction-draft": {
      title: "Create correction draft",
      description:
        "Create an editable correction or cancellation draft linked to a finalized original; never changes or reissues the original. Requires Base write access and current original version.",
      target: "table",
      input: CorrectionDraftInputSchema.omit({ tableId: true }),
      data: IntegrityRecordDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      policy: { silent: "shared" },
      review: (input, context) => reviewed(context, "Create this correction draft", "Diesen Korrekturentwurf erstellen", input),
      run: (input, context) =>
        withCapabilityAudit(context, async () => {
          const result = await createCorrectionDraft({ ...input, tableId: context.target?.id ?? "" }, await integrityContext(context));
          return result.ok ? ok({ data: result.data, refs: [{ type: "grids.record", id: result.data.id }] }) : result;
        }),
    },
    "document.capture": {
      title: "Capture document data",
      description:
        "Freeze a complete permission-checked GQL result in Grids, independent of any workflow. The immutable handle pins the values for document.issue. Truncated results are rejected.",
      target: "base",
      input: captureInput,
      data: DocumentCaptureDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      policy: { silent: "shared" },
      review: (input, context) => reviewed(context, "Capture these document data", "Diese Dokumentdaten festhalten", input),
      run: (input, context) =>
        withCapabilityAudit(context, () =>
          integrityAttempt(async () => {
            if (!context.idempotencyKey) return fail(err.badInput("Idempotency key required."));
            const baseId = await base(context.target?.id ?? "", context);
            const dates = (await integrityContext(context)).dateConfig;
            const parsed = parseGridsQueryDsl(input.query);
            if (!parsed.ok) return fail(err.badInput("Invalid GQL."));
            const resolver = await buildTrustedGqlResolverContext({ baseId, ast: parsed.ast, purpose: "workflow-query" });
            const binding = bindQueryData(input.query, resolver, {}, context.locale);
            if (!binding.ok) return binding;
            const captured = await captureQueryData({
              baseId,
              binding: binding.data.binding,
              values: {},
              timeZone: dates.timeZone,
              locale: context.locale,
              signal: context.signal,
              createTableAccess: async (client) => async (tableId) => {
                await authorizer(baseId, context)([tableId], client);
                return true;
              },
            });
            if (!captured.ok) return captured;
            const persisted = await persistDocumentData(
              {
                baseId,
                capture: captured.data,
                actor: documentActor(context.actor),
                requestId: context.requestId,
                operationKey: `capability:${context.idempotencyKey}`,
              },
              sql,
            );
            return persisted.ok
              ? ok({
                  data: {
                    id: persisted.data.shortId,
                    sha256: persisted.data.reference.sha256,
                    rowCount: persisted.data.reference.rowCount,
                    capturedAt: persisted.data.reference.capturedAt,
                  },
                })
              : persisted;
          }),
        ),
    },
    "document.issue": {
      title: "Issue captured document",
      description:
        "Issue an immutable PDF, CSV, JSON, XML or ZIP from frozen data. DATEV/SEPA reserve a versioned preview and require document.confirm before issuance. Financial exports require pinned source versions and retain duplicate-export claims. Always asks.",
      target: "base",
      input: issueInput,
      data: issueData,
      destructive: true,
      openWorld: false,
      idempotency: "required",
      policy: { ask: "cannot_undo" },
      review: (input, context) =>
        reviewed(
          context,
          "Issue this document from the pinned capture. Financial exports require a separate exact preview confirmation.",
          "Dieses Dokument aus der festgehaltenen Datenaufnahme ausgeben. Finanzexporte benötigen eine separate Bestätigung der genauen Vorschau.",
          input,
        ),
      run: (input, context) =>
        withCapabilityAudit(context, () =>
          integrityAttempt<{ data: z.infer<typeof issueData>; refs?: Array<{ type: string; id: string }> }>(async () => {
            if (!context.idempotencyKey) return fail(err.badInput("Idempotency key required."));
            const baseId = await base(context.target?.id ?? "", context);
            if ((input.output.kind === "datev-csv" || input.output.kind === "sepa-xml") && !input.sourceVersions)
              return fail(
                err.badInput(text(context, "Financial exports require source versions.", "Finanzexporte benötigen Quellversionen.")),
              );
            const captured = await resolveDocumentData(baseId, input.data.id, input.data.sha256, context.locale, sql);
            if (!captured.ok) return captured;
            if (captured.data.reference.rowCount !== input.data.rowCount || captured.data.reference.capturedAt !== input.data.capturedAt)
              return fail(err.conflict("Document capture changed."));
            let output = input.output;
            if (output.kind === "zip") {
              const files = [];
              for (const selection of output.files) {
                const template = selection.template ? await resolvePublicId("documentTemplate", selection.template) : undefined;
                if (selection.template && !template) return fail(err.notFound("Document template"));
                files.push({ ...selection, ...(template ? { template } : {}) });
              }
              const include = [];
              for (const id of output.include) {
                const document = await resolvePublicId("document", id);
                if (!document) return fail(err.notFound("Document"));
                include.push(document);
              }
              output = { ...output, files, include };
            }
            const result = await documentIssuanceService.issueQueryDocument({
              ...input,
              output,
              data: captured.data.reference,
              baseId,
              runId: null,
              stepKey: `capability:${context.idempotencyKey}`,
              actor: documentActor(context.actor),
              filename: input.filename ?? null,
              idempotencyKey: `capability:${context.idempotencyKey}`,
              locale: context.locale,
              authorize: authorizer(baseId, context),
            });
            if (!result.ok) return result;
            if ("kind" in result.data)
              return ok({ data: { state: "confirmationRequired" as const, receiptId: result.data.receiptId, sha256: result.data.sha256 } });
            const [document] = await projectDocuments([result.data]);
            return ok({
              data: { state: "issued" as const, document: DocumentCapabilityDataSchema.parse(document) },
              refs: [{ type: "grids.document", id: result.data.shortId }],
            });
          }),
        ),
    },
    "document.confirm": {
      title: "Confirm financial document",
      description:
        "Confirm the exact frozen DATEV/SEPA preview as its original actor after current permission and source-version checks. Completes issuance from that exact reserved request. Never submits a bank payment. Always asks.",
      target: "base",
      input: confirmationInput,
      data: DocumentCapabilityDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "required",
      policy: { ask: "cannot_undo" },
      review: (input, context) =>
        integrityAttempt(async () => {
          const preview = await documentIssuanceService.inspectQueryDocumentConfirmation(await confirmationRequest(input, context));
          if (!preview.ok) return preview;
          if (preview.data.sha256 !== input.sha256) return fail(err.conflict("Confirmation changed."));
          return ok(
            gridsActionReview(
              context,
              text(context, "Confirm this exact financial export", "Diesen genauen Finanzexport bestätigen"),
              preview.data,
            ),
          );
        }),
      run: (input, context) =>
        withCapabilityAudit(context, () =>
          integrityAttempt(async () => {
            const confirmed = await documentIssuanceService.confirmQueryDocument({
              ...(await confirmationRequest(input, context)),
              sha256: input.sha256,
            });
            if (!confirmed.ok) return confirmed;
            const issued = await documentIssuanceService.completeQueryDocument(await confirmationRequest(input, context));
            if (!issued.ok) return issued;
            if ("kind" in issued.data) return fail(err.conflict("Confirmation required."));
            const [document] = await projectDocuments([issued.data]);
            return ok({ data: DocumentCapabilityDataSchema.parse(document), refs: [{ type: "grids.document", id: issued.data.shortId }] });
          }),
        ),
    },
  },
});

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
const documentData = DocumentCapabilityDataSchema;
const documentContentInput = readInput.extend({
  artifactKey: documentData.shape.artifacts.element.shape.key
    .optional()
    .describe("Artifact key from document.read; defaults to the primary artifact."),
});
const documentStreamSource = documentContentInput.required();
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
const documentResult = async (document: Parameters<typeof projectDocuments>[0][number]) => {
  const [value] = await projectDocuments([document]);
  const data = documentData.parse(value);
  return {
    data,
    refs: [{ type: "grids.document", id: document.shortId, title: data.number }],
    links: [
      { rel: "download" as const, href: documentDownloadUrl(document.shortId) },
      { rel: "open" as const, href: `${baseHref({ shortId: data.baseId })}/documents?q=${encodeURIComponent(data.number)}` },
    ],
  };
};
const loadIssuance = async (input: z.infer<typeof createInput>, context: CapabilityExecutionContext, resume = false) => {
  const loaded = await loadTemplateAndTable(input.templateId, { includeDeleted: resume });
  if (!loaded || loaded.table.shortId !== context.target?.id) return missing();
  const gate = await gateBaseAtAccess(context, loaded.table.baseId, "write");
  if (!gate.ok) return gate;
  if (!resume && !loaded.template.enabled) return fail(err.badInput(capabilityMessagesFor(context.locale).documentTemplateDisabled));
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
  const base = workflow ? await gridsService.base.get(workflow.baseId) : null;
  if (!base || base.shortId !== context.target?.id) return missing();
  const tableId = workflow?.plan.bindings[`inputs.${launcher.config.input}.table`];
  if (typeof tableId !== "string") return missing();
  const table = await gridsService.table.get(tableId);
  if (!table || table.baseId !== base.id) return missing();
  const recordId = await resolvePublicId("record", input.recordId);
  const record = recordId
    ? await gridsService.record.get(tableId, recordId, { viewer: actorViewerFor(context), dateConfig: await dateConfig(context) })
    : null;
  return record ? ok({ launcher, record, principal }) : missing();
};

export const dailyCapabilities = defineCapabilities({
  protocolVersion: 2,
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
        "Read metadata and artifact hashes for a grids.document ref from document.list or document.create. Every document and artifact carries an authenticated downloadUrl that returns stored bytes, not a new rendering.",
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
    "document.content.read": {
      title: "Read document content",
      description:
        "Read one stored immutable artifact as an authenticated binary stream. Use a document ID from document.list/read/create and optionally an artifact key from document.read. Does not render, issue, extract text or send a document.",
      input: documentContentInput,
      data: documentData.shape.artifacts.element,
      openWorld: false,
      stream: {
        direction: "read",
        maxBytes: MAX_DOCUMENT_ARTIFACT_BYTES,
        async read(stream, context) {
          context.signal.throwIfAborted();
          const source = documentStreamSource.parse(JSON.parse(stream.id));
          const document = await gridsService.document.getDocumentByShortId(source.id);
          if (!document) throw err.notFound("Document");
          const gate = await gateBaseAtAccess(context, document.baseId, "read");
          if (!gate.ok) throw gate.error;
          const artifact = await gridsService.document.getDocumentArtifact(document.id, source.artifactKey, context.locale);
          if (!artifact.ok) throw artifact.error;
          context.signal.throwIfAborted();
          return fileResponse(artifact.data.bytes, artifact.data.filename, artifact.data.mimeType);
        },
      },
      async run(input, context) {
        context.signal.throwIfAborted();
        const document = await gridsService.document.getDocumentByShortId(input.id);
        if (!document) return missing();
        const gate = await gateBaseAtAccess(context, document.baseId, "read");
        if (!gate.ok) return gate;
        const key = input.artifactKey ?? document.primaryArtifactKey;
        const artifact = document.artifacts.find((item) => item.key === key);
        if (!artifact) return missing();
        return ok({
          data: documentData.shape.artifacts.element.parse({
            key: artifact.key,
            filename: artifact.filename,
            mimeType: artifact.mimeType,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
            downloadUrl: documentArtifactDownloadUrl(document.shortId, artifact.key),
          }),
          refs: [{ type: "grids.document", id: document.shortId }],
          stream: {
            id: JSON.stringify({ id: document.shortId, artifactKey: key }),
            direction: "read" as const,
            name: artifact.filename,
            mediaType: artifact.mimeType,
            size: artifact.sizeBytes,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
        });
      },
    },
    "workflow.record-actions": {
      title: "Find record workflow actions",
      description:
        "Discover configured correction/cancellation Draft actions in a base from base.list. Pages may be empty after permission/revision filtering; follow nextOffset. Use the returned table with GQL to find a finalized original, then workflow.record-action.",
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
        "Read the current status of a grids.workflow-run ref returned by workflow.record-action. Requires base read access; no raw inputs, results or internal event payloads are returned.",
      input: readInput,
      data: runData,
      openWorld: false,
      async run(input, context) {
        const run = await getWorkflowRunByShortId(input.id);
        const workflow = run?.workflowId ? await gridsService.workflow.get(run.workflowId, true) : null;
        if (!run || !workflow) return missing();
        const gate = await gateBaseAtAccess(context, workflow.baseId, "read");
        if (!gate.ok) return gate;
        const base = await gridsService.base.get(workflow.baseId);
        if (!base) return missing();
        return ok({
          data: { id: input.id, status: run.status, mode: run.mode },
          refs: [{ type: "grids.workflow-run", id: input.id }],
          links: [{ rel: "open", href: baseHref(base) }],
        });
      },
    },
  },
  actions: {
    "document.create": {
      policy: { ask: "cannot_undo" },
      title: "Issue an immutable document",
      description:
        "Issue one document from document.templates and a Record. This may assign an irreversible invoice/document number. Review every issuance; reuse the capability idempotency key only for retries of the same request. No compliance guarantee or external delivery.",
      target: "table",
      input: createInput,
      data: documentData,
      destructive: true,
      openWorld: false,
      idempotency: "required",
      async review(input, context) {
        const loaded = await loadIssuance(input, context);
        if (!loaded.ok) return loaded;
        return ok(
          gridsActionReview(context, capabilityMessagesFor(context.locale).issueDocumentReview, {
            input,
            message: capabilityMessagesFor(context.locale).issueDocumentReview,
            details: [
              { label: capabilityMessagesFor(context.locale).template, value: loaded.data.template.name },
              { label: capabilityMessagesFor(context.locale).record, value: input.recordId },
            ],
          }),
        );
      },
      async run(input, context) {
        return withCapabilityAudit(context, async () => {
          if (!context.idempotencyKey) return fail(err.badInput(capabilityMessagesFor(context.locale).idempotencyRequired));
          const loaded = await loadIssuance(input, context, true);
          if (!loaded.ok) return loaded;
          const result = await gridsService.document.createDocumentForRecord({
            ...loaded.data,
            recordId: loaded.data.record.id,
            actor: documentActor(context.actor),
            idempotencyKey: operationKey(context, "document.create"),
            viewer: actorViewerFor(context),
            dateConfig: await dateConfig(context),
            canReadTable: async (target, client) => (await gateBaseAtAccess(context, target.baseId, "read", client)).ok,
          });
          return result.ok ? ok(await documentResult(result.data)) : result;
        });
      },
    },
    "workflow.record-action": {
      policy: { ask: "app_asks" },
      title: "Run a record workflow action",
      description:
        "Create one linked correction/cancellation Draft through an action from workflow.record-actions at its exact revision. The original must be finalized and remains unchanged. No issuance or external delivery. Obtain explicit approval; no arbitrary workflow source or extra inputs. Follow the run ref for status.",
      target: "base",
      input: recordActionInput,
      data: PublicWorkflowInvocationReceiptSchema,
      destructive: true,
      openWorld: false,
      idempotency: "required",
      async review(input, context) {
        const loaded = await loadRecordAction(input, context);
        if (!loaded.ok) return loaded;
        return ok(
          gridsActionReview(context, capabilityMessagesFor(context.locale).recordActionReview, {
            input,
            message: capabilityMessagesFor(context.locale).recordActionReview,
            details: [
              { label: capabilityMessagesFor(context.locale).action, value: loaded.data.launcher.name },
              { label: capabilityMessagesFor(context.locale).record, value: input.recordId },
              { label: capabilityMessagesFor(context.locale).revision, value: String(input.expectedRevision) },
            ],
          }),
        );
      },
      async run(input, context) {
        return withCapabilityAudit(context, async () => {
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
        });
      },
    },
  },
});
const GQL_CAPABILITY_RESULT_BUDGET_BYTES = CAPABILITY_MAX_RESULT_BYTES - 32 * 1024;
const REVIEW_VALUES_MAX_CHARS = 9_000;
const REVIEW_FIELD_DETAILS = 17;

const capabilityDateConfig = async (locale?: string) => ({
  timeZone: normalizeTimeZone(String((await settingsGet<string>("app.timezone")) || "").trim(), "UTC"),
  locale: locale ?? "en",
  firstDayOfWeek: 1 as const,
});

const notFoundError = (message: string) => ({ ...err.notFound("Resource"), message });

const accessContext = (context: CapabilityExecutionContext): GridsAccessContext => ({
  actor: context.actor,
  accessSubject: context.accessSubject,
});

const gqlRuntimeContext = async (context: CapabilityExecutionContext): Promise<GridsGqlRuntimeContext> => ({
  access: accessContext(context),
  dateConfig: await capabilityDateConfig(context.locale),
  signal: context.signal,
});

const encodeCursor = (offset: number): string => Buffer.from(JSON.stringify({ v: 1, offset }), "utf8").toString("base64url");

const decodeCursor = (cursor: string | undefined, locale?: string) => {
  const t = capabilityMessagesFor(locale);
  if (!cursor) return ok(0);
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; offset?: unknown };
    return value.v === 1 && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0
      ? ok(Number(value.offset))
      : fail(err.badInput(t.invalidCursor));
  } catch {
    return fail(err.badInput(t.invalidCursor));
  }
};

const mapBase = (base: Base) => ({
  id: base.shortId,
  name: base.name,
  description: base.description,
  createdAt: base.createdAt,
  updatedAt: base.updatedAt,
});

const baseHref = (base: Pick<Base, "shortId">) => `/app/grids/${base.shortId}`;
const tableHref = (base: Pick<Base, "shortId">, table: Pick<Table, "shortId">) => `${baseHref(base)}/table/${table.shortId}`;
const viewHref = (base: Pick<Base, "shortId">, table: Pick<Table, "shortId">, viewShortId: string) =>
  `${tableHref(base, table)}/view/${viewShortId}`;
const recordHref = (base: Pick<Base, "shortId">, table: Pick<Table, "shortId">, recordShortId: string) =>
  `${tableHref(base, table)}?record=${encodeURIComponent(recordShortId)}`;

const visibleBaseParams = (access: GridsAccessContext) => {
  const viewer = actorViewerFor(access);
  const boundBaseId = resourceBoundBaseIdFor(access);
  return { viewer, boundBaseId };
};

const runBaseSearch = async (input: UniversalSearchInput, context: CapabilityExecutionContext) => {
  const t = capabilityMessagesFor(context.locale);
  const access = accessContext(context);
  const scope = await gateCredentialScopeFor(access, "read");
  const { viewer, boundBaseId } = visibleBaseParams(access);
  if (!scope.ok || boundBaseId === null) return ok({ data: [] });
  const result = await gridsService.base.listVisible({
    ...viewer,
    ...(boundBaseId ? { baseId: boundBaseId } : {}),
    query: input.query,
    limit: input.limit,
    offset: 0,
  });
  const data: CloudResourceView[] = result.items.map((base) => ({
    ref: { type: "grids.base", id: base.shortId },
    title: base.name,
    preview: base.description ?? undefined,
    icon: "ti ti-table",
    priority: 7,
    metadata: [{ label: t.type, value: t.base }],
    links: [{ rel: "open", href: baseHref(base) }],
  }));
  return ok({ data });
};

const runBaseList = async (input: z.infer<typeof BaseListInputSchema>, context: CapabilityExecutionContext) => {
  const t = capabilityMessagesFor(context.locale);
  const cursor = decodeCursor(input.cursor, context.locale);
  if (!cursor.ok) return cursor;
  const access = accessContext(context);
  const scope = await gateCredentialScopeFor(access, "read");
  if (!scope.ok) return scope;
  const { viewer, boundBaseId } = visibleBaseParams(access);
  if (boundBaseId === null) return fail(err.forbidden(t.credentialNotBound));
  const result = await gridsService.base.listVisible({
    ...viewer,
    ...(boundBaseId ? { baseId: boundBaseId } : {}),
    query: input.query,
    limit: input.limit,
    offset: cursor.data,
  });
  const data = result.items.map((base) => ({
    ...mapBase(base),
    links: [{ rel: "open" as const, href: baseHref(base) }],
  }));
  const nextOffset = cursor.data + data.length;
  const hasMore = nextOffset < result.total;
  return ok({
    data,
    refs: data.map((base) => ({ type: "grids.base", id: base.id })),
    page: capabilityPage(hasMore ? encodeCursor(nextOffset) : undefined),
  });
};

const requireBase = async (baseShortId: string, access: GridsAccessContext, locale?: string) => {
  const t = capabilityMessagesFor(locale);
  const base = await gridsService.base.getByShortId(baseShortId);
  if (!base) return fail(notFoundError(t.baseNotFound));
  const gate = await gateBaseAtAccess(access, base.id, "read");
  if (!gate.ok) return gate;
  return ok(base);
};

const requireTable = async (tableShortId: string, access: GridsAccessContext, required: "read" | "write", locale?: string) => {
  const t = capabilityMessagesFor(locale);
  const table = await gridsService.table.getByShortId(tableShortId);
  if (!table) return fail(notFoundError(t.tableNotFound));
  const gate = await gateBaseAtAccess(access, table.baseId, required);
  return gate.ok ? ok(table) : gate;
};

const runBaseRead = async (input: z.infer<typeof BaseReadInputSchema>, context: CapabilityExecutionContext) => {
  const t = capabilityMessagesFor(context.locale);
  const base = await gridsService.base.getByShortId(input.id);
  if (!base) return fail(notFoundError(t.baseNotFound));
  const permission = await gateBaseAtAccess(accessContext(context), base.id, "read");
  if (!permission.ok) return permission;
  if (permission.data === "none") return fail(err.forbidden(t.noResourceAccess));
  return ok({
    data: { ...mapBase(base), view: { title: base.name, permission: permission.data } },
    summary: t.readBase({ name: base.name }),
    refs: [{ type: "grids.base", id: base.shortId }],
    links: [{ rel: "open" as const, href: baseHref(base) }],
  });
};

const runTableRead = async (input: z.infer<typeof TableReadInputSchema>, context: CapabilityExecutionContext) => {
  const t = capabilityMessagesFor(context.locale);
  const table = await gridsService.table.getByShortId(input.id);
  if (!table) return fail(notFoundError(t.tableNotFound));
  const permission = await gateBaseAtAccess(accessContext(context), table.baseId, "read");
  if (!permission.ok) return permission;
  if (permission.data === "none") return fail(err.forbidden(t.noResourceAccess));
  const base = await gridsService.base.get(table.baseId);
  if (!base) return fail(notFoundError(t.tableNotFound));
  return ok({
    data: tableContextItem(table, base, permission.data),
    summary: t.readTable({ name: table.name }),
    refs: [{ type: "grids.table", id: table.shortId }],
    links: [{ rel: "open" as const, href: tableHref(base, table) }],
  });
};

const runViewRead = async (input: z.infer<typeof ViewReadInputSchema>, context: CapabilityExecutionContext) => {
  const t = capabilityMessagesFor(context.locale);
  const view = await gridsService.view.getByShortId(input.id);
  if (!view) return fail(notFoundError(t.viewNotFound));
  const table = await gridsService.table.get(view.tableId);
  if (!table) return fail(notFoundError(t.viewNotFound));
  const permission = await gateBaseAtAccess(accessContext(context), table.baseId, "read");
  if (!permission.ok) return permission;
  const base = await gridsService.base.get(table.baseId);
  if (!base) return fail(notFoundError(t.viewNotFound));
  return ok({
    data: {
      kind: "view" as const,
      id: view.shortId,
      tableId: table.shortId,
      name: view.name,
      description: view.description,
      icon: view.icon ?? null,
    },
    summary: t.readView({ name: view.name }),
    refs: [{ type: "grids.view", id: view.shortId, title: view.name }],
    links: [{ rel: "open" as const, href: viewHref(base, table, view.shortId) }],
  });
};

const selectOptions = (field: Field): Array<{ id: string; label: string; description: string | null }> => {
  const options = (field.config as { options?: unknown }).options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (!option || typeof option !== "object") return [];
    const { id, label, description } = option as { id?: unknown; label?: unknown; description?: unknown };
    if (typeof id !== "string" || !id || id.length > 10_000) return [];
    const readableLabel = typeof label === "string" && label.trim() ? label.trim() : id;
    return [{ id, label: readableLabel.slice(0, 500), description: typeof description === "string" ? description.slice(0, 1_000) : null }];
  });
};

const fieldValueHint = (field: Field, locale?: string): string | null => {
  const t = capabilityMessagesFor(locale);
  const config = field.config as Record<string, unknown>;
  switch (field.type) {
    case "text":
    case "longtext":
      return t.stringValueHint;
    case "number":
      return t.numberValueHint;
    case "object_list":
      return t.listValueHint;
    case "percent":
      return config.range === "fraction" ? t.fractionValueHint : t.percentValueHint;
    case "boolean":
      return t.booleanValueHint;
    case "date":
      return config.includeTime ? t.dateTimeValueHint : t.dateValueHint;
    case "duration":
      return t.durationValueHint;
    case "select":
      return t.selectValueHint;
    case "principal":
      return t.principalValueHint;
    case "resource":
      return t.resourceValueHint;
    case "json":
      return t.jsonValueHint;
    case "relation":
      return config.cardinality === "single" ? t.singleRelationValueHint : t.multipleRelationValueHint;
    default:
      return null;
  }
};

type GqlContextItem = z.infer<typeof GqlContextItemSchema>;
type TableContextItem = Extract<GqlContextItem, { kind: "table" }>;

const allowsDirectMutations = (table: Table): boolean =>
  table.mutationPolicy.mode === "all" || table.mutationPolicy.sources.includes("direct");

const tableContextItem = (table: Table, base: Base, permission: "read" | "write" | "admin"): z.infer<typeof TableCapabilityDataSchema> => ({
  kind: "table",
  id: table.shortId,
  baseId: base.shortId,
  tableKind: table.kind,
  name: table.name,
  description: table.description,
  icon: table.icon ?? null,
  permission,
  canCreateRecords: table.kind === "stored" && permission !== "read" && allowsDirectMutations(table) && !table.disableDirectInsert,
  canUpdateRecords: table.kind === "stored" && permission !== "read" && allowsDirectMutations(table),
});

const fieldContextItem = (
  field: Field,
  table: Table,
  readableTablesById: ReadonlyMap<string, Table>,
  canUpdateRecords: boolean,
  includeWriteContext: boolean,
  locale?: string,
): GqlContextItem => {
  const configuredTarget = (field.config as { targetTableId?: unknown }).targetTableId;
  const targetTableId = typeof configuredTarget === "string" ? (readableTablesById.get(configuredTarget)?.shortId ?? null) : null;
  const configuredCardinality = (field.config as { cardinality?: unknown }).cardinality;
  return {
    kind: "field",
    id: field.shortId,
    tableId: table.shortId,
    name: field.name,
    description: field.description,
    type: field.type,
    ...(includeWriteContext ? { required: field.required, writable: canUpdateRecords && isRecordWritableFieldType(field.type) } : {}),
    valueHint: fieldValueHint(field, locale),
    targetTableId,
    relationCardinality:
      field.type === "relation" && (configuredCardinality === "single" || configuredCardinality === "multiple")
        ? configuredCardinality
        : field.type === "relation"
          ? "multiple"
          : null,
  };
};

const recordWriteContext = (table: Table, fieldsById: ReadonlyMap<string, Field>, permission: "read" | "write" | "admin") => {
  const canUpdateRecords = table.kind === "stored" && permission !== "read" && allowsDirectMutations(table);
  const updateAudit = canUpdateRecords && table.auditPolicy.update?.enabled ? table.auditPolicy.update : null;
  return {
    tableId: table.shortId,
    canCreateRecords: canUpdateRecords && !table.disableDirectInsert,
    canUpdateRecords,
    updateAudit: updateAudit
      ? {
          scope: updateAudit.scope,
          fieldIds: updateAudit.fieldIds.flatMap((fieldId) => {
            const field = fieldsById.get(fieldId);
            return field ? [field.shortId] : [];
          }),
          questions: auditQuestions(table),
        }
      : null,
  };
};

const auditQuestions = (table: Table) =>
  table.auditPolicy.update?.questions.map((question) => ({
    ...question,
    description: question.description ?? null,
  })) ?? [];

const pageContextItems = (items: GqlContextItem[], offset: number, limit: number) => {
  const data: GqlContextItem[] = [];
  for (const item of items.slice(offset, offset + limit)) {
    if (data.length > 0 && new TextEncoder().encode(JSON.stringify([...data, item])).byteLength > GQL_CAPABILITY_RESULT_BUDGET_BYTES) break;
    data.push(item);
  }
  const nextOffset = offset + data.length;
  const hasMore = nextOffset < items.length;
  return { data, page: capabilityPage(hasMore ? encodeCursor(nextOffset) : undefined) };
};

const runGqlContext = async (input: z.infer<typeof GqlContextInputSchema>, context: CapabilityExecutionContext) => {
  const t = capabilityMessagesFor(context.locale);
  const cursor = decodeCursor(input.cursor, context.locale);
  if (!cursor.ok) return cursor;
  const access = accessContext(context);
  const baseResult = await requireBase(context.target?.id ?? "", access, context.locale);
  if (!baseResult.ok) return baseResult;
  // Even optional filters must stay inside the declared base when this section does not use them.
  if (input.tableId) {
    const table = await requireTable(input.tableId, access, "read", context.locale);
    if (!table.ok || table.data.baseId !== baseResult.data.id) return fail(notFoundError(t.tableNotFound));
  }
  if (input.fieldId) {
    const field = await gridsService.field.getByShortId(input.fieldId);
    const table = field ? await gridsService.table.get(field.tableId) : null;
    if (!field || !table || table.baseId !== baseResult.data.id || (input.tableId && table.shortId !== input.tableId))
      return fail(notFoundError(t.selectFieldNotFound));
  }

  let items: GqlContextItem[];
  let recordWrite: ReturnType<typeof recordWriteContext> | undefined;
  let list: z.infer<typeof GqlContextDataSchema>["list"];
  if (input.kind === "tables") {
    const [resolver, tables] = await Promise.all([
      buildPermissionedGqlResolverContextForAccess(access, baseResult.data.id, undefined, undefined, emptyDslAst()),
      gridsService.table.listByBase(baseResult.data.id),
    ]);
    const tablesById = new Map(tables.map((table) => [table.id, table]));
    const tableItems: TableContextItem[] = resolver.tables.flatMap((source) => {
      const table = tablesById.get(source.id);
      const permission = resolver.tablePermissionsById[source.id];
      return table && permission && permission !== "none"
        ? [
            {
              kind: "table",
              id: table.shortId,
              tableKind: table.kind,
              name: table.name,
              description: table.description,
            },
          ]
        : [];
    });
    tableItems.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    items = tableItems;
  } else if (input.kind === "fields" || input.kind === "options" || input.kind === "list-columns") {
    if (!input.tableId) return fail(err.badInput(t.tableIdRequired({ kind: input.kind })));
    if (input.kind === "options" && !input.fieldId) return fail(err.badInput(t.fieldIdRequiredForOptions));
    if (input.kind === "list-columns" && !input.fieldId) return fail(err.badInput(t.listFieldRequired));
    const tableResult = await requireTable(input.tableId, access, "read", context.locale);
    if (!tableResult.ok || tableResult.data.baseId !== baseResult.data.id) return fail(notFoundError(t.tableNotFound));
    const fieldResult = input.fieldId ? await gridsService.field.getByShortId(input.fieldId) : null;
    if (input.fieldId && (!fieldResult || fieldResult.tableId !== tableResult.data.id))
      return fail(notFoundError(input.kind === "list-columns" ? t.listFieldNotFound : t.selectFieldNotFound));
    const resolver = await buildPermissionedGqlResolverContextForAccess(
      access,
      baseResult.data.id,
      tableResult.data.id,
      { kind: "table", tableId: tableResult.data.id },
      emptyDslAst(),
    );
    const table = resolver.tables.find((candidate) => candidate.id === tableResult.data.id);
    if (!table) return fail(notFoundError(t.tableNotFound));
    const permission = resolver.tablePermissionsById[tableResult.data.id];
    if (!permission || permission === "none") return fail(notFoundError(t.tableNotFound));
    const readableTableIds = new Set(resolver.tables.map((candidate) => candidate.id));
    const readableTablesById = new Map(
      (await gridsService.table.listByBase(baseResult.data.id))
        .filter((candidate) => readableTableIds.has(candidate.id))
        .map((candidate) => [candidate.id, candidate]),
    );
    const fields = (resolver.fieldsByTableId[tableResult.data.id] ?? []).filter((field) => !field.deletedAt);
    const fieldsById = new Map(fields.map((field) => [field.id, field]));
    if (input.kind === "fields") {
      const writeContext = recordWriteContext(tableResult.data, fieldsById, permission);
      if (input.includeWriteContext) recordWrite = writeContext;
      items = fields
        .filter((field) => !fieldResult || field.id === fieldResult.id)
        .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
        .map((field) =>
          fieldContextItem(
            field,
            tableResult.data,
            readableTablesById,
            writeContext.canUpdateRecords,
            input.includeWriteContext,
            context.locale,
          ),
        );
    } else if (input.kind === "list-columns") {
      const field = fields.find((candidate) => candidate.id === fieldResult?.id);
      if (!field || field.type !== "object_list") return fail(notFoundError(t.listFieldNotFound));
      const parsed = ObjectListConfigSchema.safeParse(field.config);
      if (!parsed.success) return fail(err.badInput(t.listConfigInvalid));
      list = { fieldId: field.shortId, minItems: Math.max(field.required ? 1 : 0, parsed.data.minItems), maxItems: parsed.data.maxItems };
      items = parsed.data.fields.map((column) => ({ kind: "list-column" as const, fieldId: field.shortId, column }));
    } else {
      const field = fields.find((candidate) => candidate.id === fieldResult?.id);
      if (!field || field.type !== "select") return fail(notFoundError(t.selectFieldNotFound));
      items = selectOptions(field).map((option) => ({ kind: "option" as const, fieldId: field.shortId, ...option }));
    }
  } else {
    let selectedTableId: string | undefined;
    if (input.tableId) {
      const table = await requireTable(input.tableId, access, "read", context.locale);
      if (!table.ok || table.data.baseId !== baseResult.data.id) return fail(notFoundError(t.tableNotFound));
      selectedTableId = table.data.id;
    }
    const resolver = await buildPermissionedGqlResolverContextForAccess(access, baseResult.data.id, undefined, undefined, emptyDslAst());
    const views = await gridsService.view.listForTables({
      tableIds: resolver.tables.map((table) => table.id),
      ...actorViewerFor(access),
    });
    const tablesById = new Map(resolver.tables.map((table) => [table.id, table]));
    items = views
      .filter((view) => !selectedTableId || view.tableId === selectedTableId)
      .flatMap((view) => {
        const table = tablesById.get(view.tableId);
        return table
          ? [
              {
                kind: "view" as const,
                id: view.shortId,
                tableId: table.shortId,
                name: view.name,
                description: view.description,
              },
            ]
          : [];
      })
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  const page = pageContextItems(items, cursor.data, input.limit);
  const refs: CloudResourceReference[] = page.data.flatMap((item) =>
    item.kind === "table" || item.kind === "view"
      ? [{ type: `grids.${item.kind}` as "grids.table" | "grids.view", id: item.id, title: item.name }]
      : [],
  );
  const result = {
    data: {
      base: { id: baseResult.data.shortId, name: baseResult.data.name },
      kind: input.kind,
      items: page.data,
      ...(recordWrite ? { recordWrite } : {}),
      ...(list ? { list } : {}),
    },
    refs,
    page: page.page,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > CAPABILITY_MAX_RESULT_BYTES) {
    return fail(err.badInput(t.contextTooLarge));
  }
  return ok(result);
};

type GqlCapabilityOutcome = { kind: "preview" | "execute"; viewName?: string; viewId?: string; queryLink?: string };

const gqlCapabilitySummary = (response: DslQueryPreviewResponse, base: Base, outcome: GqlCapabilityOutcome, locale?: string) => {
  const t = capabilityMessagesFor(locale);
  if (!response.ok) {
    return outcome.kind === "preview"
      ? t.gqlPreviewInvalid({ count: response.diagnostics.length })
      : t.gqlExecutionInvalid({ count: response.diagnostics.length });
  }
  return [
    outcome.viewName
      ? t.executedSavedView({ name: outcome.viewName, count: response.rows.length })
      : t.gqlOutcome({ preview: outcome.kind === "preview", base: base.name, count: response.rows.length }),
    ...(response.truncated ? [t.queryCapped] : []),
    ...(!outcome.queryLink ? [t.queryCopy] : []),
  ].join(" ");
};

const gqlCapabilityResult = async (
  response: DslQueryPreviewResponse,
  base: Base,
  outcome: GqlCapabilityOutcome,
  context: CapabilityExecutionContext,
  showTableToUser: boolean,
) => {
  const locale = context.locale;
  const t = capabilityMessagesFor(locale);
  const refs: CloudResourceReference[] = outcome.viewId
    ? [{ type: "grids.view", id: outcome.viewId, ...(outcome.viewName ? { title: outcome.viewName.slice(0, 500) } : {}) }]
    : [];
  if (!response.ok) {
    const tooLarge = response.diagnostics.find((diagnostic) => diagnostic.message.startsWith("GQL result is too large."));
    return tooLarge
      ? fail(err.badInput(tooLarge.message))
      : ok({
          data: response,
          summary: gqlCapabilitySummary(response, base, outcome, locale),
          refs: [{ type: "grids.base" as const, id: base.shortId }, ...refs],
          links: [{ rel: "open" as const, href: baseHref(base) }],
        });
  }
  const tableIds = [...new Set(response.rows.flatMap((row) => (row.tableId ? [row.tableId] : [])))];
  const tables = tableIds.length > 0 ? await gridsService.table.listByBase(base.id) : [];
  const wantedTableIds = new Set(tableIds);
  const tablesById = new Map(tables.filter((table) => wantedTableIds.has(table.id)).map((table) => [table.id, table]));
  let projected: Awaited<ReturnType<typeof toPublicGqlResponse>>;
  try {
    projected = await toPublicGqlResponse(response);
  } catch {
    return fail(err.internal(t.publicIdProjectionFailed));
  }
  if (!projected.ok) return fail(err.internal(t.successfulProjectionFailed));
  const { page, columns, ...resultData } = projected;
  const labelIds = new Map<string, Set<string>>();
  for (const row of response.rows) {
    if (!row.tableId || !row.recordId) continue;
    const ids = labelIds.get(row.tableId) ?? new Set<string>();
    ids.add(row.recordId);
    labelIds.set(row.tableId, ids);
  }
  const labels = await buildRelationLabelCacheForIds(labelIds, actorViewerFor(accessContext(context)));
  const data = {
    ...resultData,
    columns: columns.map(({ sqlType: _sqlType, ...column }) => column),
    rows: projected.rows.map((row, index) => {
      const { recordMeta: _recordMeta, ...values } = row;
      const internalRow = response.rows[index];
      const table = internalRow?.tableId ? tablesById.get(internalRow.tableId) : undefined;
      return {
        ...values,
        ...(row.recordId && table ? { links: [{ rel: "open" as const, href: recordHref(base, table, row.recordId) }] } : {}),
      };
    }),
  };
  const seen = new Set<string>();
  for (const [index, row] of projected.rows.entries()) {
    if (!row.recordId || seen.has(row.recordId)) continue;
    if (refs.length === 100) break;
    seen.add(row.recordId);
    const internalRow = response.rows[index];
    const label = internalRow?.recordId ? labels[internalRow.recordId] : undefined;
    const table = internalRow?.tableId ? tablesById.get(internalRow.tableId) : undefined;
    refs.push({
      type: "grids.record",
      id: row.recordId,
      ...(label ? { title: label.slice(0, 500) } : {}),
      ...(table ? { preview: table.name, icon: table.icon ?? "ti ti-table" } : {}),
    });
  }
  const nextCursor = page?.nextCursor ?? undefined;
  const result = {
    data,
    summary: gqlCapabilitySummary(response, base, outcome, locale),
    refs,
    ...(outcome.queryLink ? { links: [{ rel: "open" as const, href: outcome.queryLink, title: t.openQuery }] } : {}),
    page: capabilityPage(nextCursor),
  };
  // Labels are optional presentation. Preserve every identity and row when
  // unusually large labels consume the reserved envelope budget.
  for (
    let index = refs.length - 1;
    index >= 0 && new TextEncoder().encode(JSON.stringify(result)).byteLength > CAPABILITY_MAX_RESULT_BYTES;
    index--
  ) {
    const ref = refs[index]!;
    refs[index] = { type: ref.type, id: ref.id };
  }
  if (!showTableToUser) return ok(result);
  const view = BlockViewSchema.safeParse(
    data.columns.length && data.columns.length <= BLOCK_LIMITS.columns && data.rows.length <= BLOCK_LIMITS.rows
      ? {
          version: 1,
          blocks: [
            {
              kind: "Table",
              title: base.name.trim().slice(0, 160) || "Results",
              rows: { from: ["rows"] },
              columns: data.columns.map((column) => ({ path: ["values", column.key], label: column.label.trim().slice(0, 80) || "Value" })),
              ...(data.rows.every((row) => typeof row.recordId === "string") ? { rowId: ["recordId"] } : {}),
              rowHref: ["links", "0", "href"],
            },
          ],
        }
      : undefined,
  );
  // A view is optional; preserve valid data when its complete envelope would exceed the transport budget.
  if (view.success && new TextEncoder().encode(JSON.stringify({ ...result, view: view.data })).byteLength <= CAPABILITY_MAX_RESULT_BYTES) {
    try {
      validateBlocks(bindView(view.data, data).blocks, "result", { appId: "grids", appPrefixes: ["/app/grids", "/api/grids"] });
      return ok({ ...result, view: view.data });
    } catch {
      /* Some query shapes have no stable row identity or scalar cells; data remains available. */
    }
  }
  return ok(result);
};

const gqlUnavailable = (error: unknown, locale?: string) =>
  isQueryAdmissionError(error)
    ? { ok: false as const, error: { code: "QUERY_BUSY", message: capabilityMessagesFor(locale).gridsBusy, status: 503 as const } }
    : Promise.reject(error);

const resolveGqlCurrentSource = async (
  baseId: string,
  input: { currentTableId?: string; currentSource?: { kind: "table"; tableId: string } | { kind: "view"; viewId: string } },
  locale?: string,
) => {
  const t = capabilityMessagesFor(locale);
  const currentTable = input.currentTableId ? await gridsService.table.getByShortId(input.currentTableId) : null;
  if (input.currentTableId && (!currentTable || currentTable.baseId !== baseId)) return fail(notFoundError(t.tableNotFound));

  if (!input.currentSource) return ok({ currentTableId: currentTable?.id, currentSource: undefined });
  if (input.currentSource.kind === "table") {
    const table = await gridsService.table.getByShortId(input.currentSource.tableId);
    if (!table || table.baseId !== baseId) return fail(notFoundError(t.tableNotFound));
    return ok({ currentTableId: currentTable?.id, currentSource: { kind: "table" as const, tableId: table.id } });
  }
  const view = await gridsService.view.getByShortId(input.currentSource.viewId);
  if (!view) return fail(notFoundError(t.viewNotFound));
  const table = await gridsService.table.get(view.tableId);
  if (!table || table.baseId !== baseId) return fail(notFoundError(t.viewNotFound));
  return ok({ currentTableId: currentTable?.id, currentSource: { kind: "view" as const, viewId: view.id } });
};

const runGqlPreview = async (input: z.infer<typeof GqlPreviewInputSchema>, context: CapabilityExecutionContext) => {
  const access = accessContext(context);
  const base = await requireBase(context.target?.id ?? "", access, context.locale);
  if (!base.ok) return base;
  const current = await resolveGqlCurrentSource(base.data.id, input, context.locale);
  if (!current.ok) return current;
  try {
    const result = await executeGqlSourceForContext(
      await gqlRuntimeContext(context),
      base.data.id,
      {
        query: input.query,
        currentTableId: current.data.currentTableId,
        currentSource: current.data.currentSource,
        cursor: input.cursor,
        pageSize: input.pageSize,
      },
      {
        maxRows: 25,
        maxResultBytes: GQL_CAPABILITY_RESULT_BUDGET_BYTES,
        operation: "preview",
        labelRelationValues: false,
        context: publicGqlParameterContext(input.parameters),
      },
    );
    return await gqlCapabilityResult(
      result.response,
      base.data,
      { kind: "preview", queryLink: queryCapabilityHref({ ...input, baseId: base.data.shortId }) },
      context,
      input.showTableToUser,
    );
  } catch (error) {
    return gqlUnavailable(error, context.locale);
  }
};

const runGqlExecute = async (input: z.infer<typeof GqlExecuteInputSchema>, context: CapabilityExecutionContext) => {
  const access = accessContext(context);
  const base = await requireBase(context.target?.id ?? "", access, context.locale);
  if (!base.ok) return base;
  const current = await resolveGqlCurrentSource(base.data.id, input, context.locale);
  if (!current.ok) return current;
  try {
    const result = await executeGqlSourceForContext(
      await gqlRuntimeContext(context),
      base.data.id,
      {
        query: input.query,
        currentTableId: current.data.currentTableId,
        currentSource: current.data.currentSource,
        cursor: input.cursor,
        pageSize: Math.min(input.pageSize, input.limit ?? input.pageSize),
      },
      {
        resultLimit: input.limit,
        context: publicGqlParameterContext(input.parameters),
        maxRows: 1_000,
        maxResultBytes: GQL_CAPABILITY_RESULT_BUDGET_BYTES,
        operation: "execute",
        labelRelationValues: false,
      },
    );
    const query = input.limit !== undefined ? (result.source ?? input.query) : input.query;
    return await gqlCapabilityResult(
      result.response,
      base.data,
      { kind: "execute", queryLink: queryCapabilityHref({ ...input, baseId: base.data.shortId, query }) },
      context,
      input.showTableToUser,
    );
  } catch (error) {
    return gqlUnavailable(error, context.locale);
  }
};

const runGqlViewExecute = async (input: z.infer<typeof GqlViewExecuteInputSchema>, context: CapabilityExecutionContext) => {
  const t = capabilityMessagesFor(context.locale);
  const base = await requireBase(context.target?.id ?? "", accessContext(context), context.locale);
  if (!base.ok) return base;
  const view = await gridsService.view.getByShortId(input.viewId);
  if (!view) return fail(notFoundError(t.viewNotFound));
  const table = await gridsService.table.get(view.tableId);
  if (!table || table.baseId !== base.data.id) return fail(notFoundError(t.viewNotFound));
  try {
    const response = await executeSavedViewSourceForContext(await gqlRuntimeContext(context), base.data.id, view.id, {
      maxRows: 1_000,
      maxResultBytes: GQL_CAPABILITY_RESULT_BUDGET_BYTES,
      pageSize: input.pageSize,
      cursor: input.cursor,
      operation: "execute",
      surface: "api",
      labelRelationValues: false,
    });
    return await gqlCapabilityResult(
      response,
      base.data,
      {
        kind: "execute",
        viewName: view.name,
        viewId: view.shortId,
        queryLink: queryCapabilityHref({ baseId: base.data.shortId, query: `from view {${view.shortId}}` }),
      },
      context,
      input.showTableToUser,
    );
  } catch (error) {
    return gqlUnavailable(error, context.locale);
  }
};

const mapRecord = (record: GridRecord, table: Table) => ({
  id: record.shortId,
  tableId: table.shortId,
  version: record.version,
  ...(record.finalizedAt ? { finalizedAt: record.finalizedAt, finalizedBy: record.finalizedBy ?? null } : {}),
  deletedAt: record.deletedAt,
  createdBy: record.createdBy,
  updatedBy: record.updatedBy,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const recordReviewValue = (value: unknown, locale?: string): string => {
  const t = capabilityMessagesFor(locale);
  if (value === null || value === undefined || value === "") return t.clearValue;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value))
    return value.length === 0 ? t.clearValues : value.map((item) => `- ${recordReviewValue(item, locale)}`).join("\n");
  return JSON.stringify(value, null, 2);
};

const boundedRecordReviewValue = (value: unknown, locale?: string): string => {
  const full = recordReviewValue(value, locale);
  return full.length > REVIEW_VALUES_MAX_CHARS
    ? `${full.slice(0, REVIEW_VALUES_MAX_CHARS)}\n\n${capabilityMessagesFor(locale).previewTruncated}`
    : full;
};

const recordValuesReview = (
  values: Record<string, unknown>,
  fields: ReadonlyArray<Field>,
  locale?: string,
  detailBudget = REVIEW_FIELD_DETAILS,
): NonNullable<CapabilityActionReview["details"]> => {
  const t = capabilityMessagesFor(locale);
  const fieldsByShortId = new Map(fields.map((field) => [field.shortId, field]));
  const entries = Object.entries(values).map(([id, value]) => {
    const field = fieldsByShortId.get(id);
    if (field?.type !== "select" || !Array.isArray(value)) return [id, value] as const;
    const labels = new Map(selectOptions(field).map((option) => [option.id, option.label]));
    return [
      id,
      value.map((option) => (typeof option === "string" && labels.has(option) ? `${labels.get(option)} (${option})` : option)),
    ] as const;
  });
  const visible = entries.slice(0, detailBudget - 1).map(([fieldId, value]) => {
    const field = fieldsByShortId.get(fieldId);
    const text = boundedRecordReviewValue(value, locale);
    if (field?.type === "date" && typeof value === "string") {
      return {
        label: field.name.slice(0, 120),
        value,
        format: field.config.includeTime === true ? ("date-time" as const) : ("date" as const),
      };
    }
    return {
      label: (field?.name ?? fieldId).slice(0, 120),
      value: text,
      ...(((typeof value === "string" && !value.includes("\n") && value.length <= 160) ||
        typeof value === "number" ||
        typeof value === "boolean") &&
      field?.type !== "longtext" &&
      field?.type !== "json"
        ? {}
        : { display: "block" as const }),
    };
  });
  const remaining = entries.slice(detailBudget - 1);
  if (remaining.length === 0) return visible;
  const additional = remaining
    .map(([fieldId, value]) => `${fieldsByShortId.get(fieldId)?.name ?? fieldId}\n${recordReviewValue(value, locale)}`)
    .join("\n\n");
  return [
    ...visible,
    {
      label: t.additionalValues({ count: remaining.length }),
      value: boundedRecordReviewValue(additional, locale),
      display: "block",
    },
  ];
};

const recordResult = async (record: GridRecord, table: Table, summary?: string, locale?: string) => {
  const base = await gridsService.base.get(table.baseId);
  if (!base) return fail(notFoundError(capabilityMessagesFor(locale).recordNotFound));
  return ok({
    data: mapRecord(record, table),
    ...(summary ? { summary } : {}),
    refs: [{ type: "grids.record", id: record.shortId }],
    links: [{ rel: "open" as const, href: recordHref(base, table, record.shortId) }],
  });
};

const runRecordRead = async (input: z.infer<typeof RecordReadInputSchema>, context: CapabilityExecutionContext) => {
  const t = capabilityMessagesFor(context.locale);
  const access = accessContext(context);
  const resolved = await gridsService.record.getByShortId(input.id);
  if (!resolved) return fail(notFoundError(t.recordNotFound));
  const table = await gridsService.table.get(resolved.tableId);
  if (!table) return fail(notFoundError(t.recordNotFound));
  const tableAccess = await gateBaseAtAccess(access, table.baseId, "read");
  if (!tableAccess.ok) return tableAccess;
  const dateConfig = await capabilityDateConfig(context.locale);
  const record = await gridsService.record.get(table.id, resolved.id, {
    dateConfig,
    viewer: actorViewerFor(access),
  });
  return record
    ? recordResult(record, table, t.readRecord({ table: table.name, version: record.version }), context.locale)
    : fail(notFoundError(t.recordNotFound));
};

const resolveRecordValues = async (tableId: string, values: Record<string, unknown>, locale?: string) => {
  const t = capabilityMessagesFor(locale);
  const fields = await gridsService.field.listByTable(tableId);
  const fieldsByShortId = new Map(fields.filter((field) => !field.deletedAt).map((field) => [field.shortId, field]));
  const entries: Array<{ field: Field; value: unknown }> = [];
  const relationPublicIds: string[] = [];
  for (const [fieldShortId, value] of Object.entries(values)) {
    const field = fieldsByShortId.get(fieldShortId);
    if (!field) return fail(err.badInput(t.unknownFieldId({ id: fieldShortId })));
    entries.push({ field, value });
    if (field.type !== "relation") continue;
    if (Array.isArray(value)) relationPublicIds.push(...value.filter((item): item is string => typeof item === "string"));
    else if (typeof value === "string") relationPublicIds.push(value);
  }
  if (relationPublicIds.some((publicId) => !ShortIdSchema.safeParse(publicId).success)) {
    return fail(err.badInput(t.relatedIdsInvalid));
  }
  const relationIds = await resolvePublicIds("record", relationPublicIds);
  if (relationPublicIds.some((publicId) => !relationIds.has(publicId))) return fail(err.badInput(t.relatedIdUnknown));
  const resolved: Record<string, unknown> = {};
  for (const { field, value } of entries) {
    resolved[field.id] =
      field.type === "relation"
        ? Array.isArray(value)
          ? value.map((item) => (typeof item === "string" ? (relationIds.get(item) ?? item) : item))
          : typeof value === "string"
            ? (relationIds.get(value) ?? value)
            : value
        : value;
  }
  return ok({ values: resolved, fields });
};

const runRecordCreate = async (input: z.infer<typeof RecordCreateInputSchema>, context: CapabilityExecutionContext) => {
  return withCapabilityAudit(context, async () => {
    const t = capabilityMessagesFor(context.locale);
    const access = accessContext(context);
    const table = await requireTable(context.target?.id ?? "", access, "write", context.locale);
    if (!table.ok) return table;
    const values = await resolveRecordValues(table.data.id, input.values, context.locale);
    if (!values.ok) return values;
    const dateConfig = await capabilityDateConfig(context.locale);
    const result = await gridsService.record.create(table.data.id, values.data.values, accessActorUser(access)?.id ?? null, "direct", {
      dateConfig,
      viewer: actorViewerFor(access),
    });
    if (!result.ok) return result;
    return recordResult(result.data, table.data, t.createdRecord({ id: result.data.shortId, table: table.data.name }), context.locale);
  });
};

const runRecordExternalUpsert = async (input: z.infer<typeof RecordExternalUpsertInputSchema>, context: CapabilityExecutionContext) => {
  return withCapabilityAudit(context, async () => {
    const t = capabilityMessagesFor(context.locale);
    if (!context.idempotencyKey) return fail(err.badInput(t.idempotencyRequired));
    const access = accessContext(context);
    const table = await requireTable(context.target?.id ?? "", access, "write", context.locale);
    if (!table.ok) return table;
    const operationScope = `capability:record.upsert-external:${gridsService.record.external.externalRecordRequestHash(context.accessSubject)}`;
    const requestHash = externalUpsertRequestHash(table.data.shortId, input);
    const replay = await gridsService.record.external.replay({
      operationScope,
      operationKey: context.idempotencyKey,
      requestHash,
      conflictKind: "capability",
    });
    if (!replay.ok) return replay;
    const receipt = replay.data;
    if (receipt) {
      const base = await gridsService.base.get(table.data.baseId);
      return ok({
        data: {
          recordId: receipt.recordShortId,
          tableId: table.data.shortId,
          version: receipt.version,
          created: receipt.created,
          changed: receipt.changed,
          replayed: true,
        },
        summary: t.replayedExternalRecord({ id: receipt.recordShortId, table: table.data.name, version: receipt.version }),
        refs: [{ type: "grids.record", id: receipt.recordShortId }],
        ...(base ? { links: [{ rel: "open" as const, href: recordHref(base, table.data, receipt.recordShortId) }] } : {}),
      });
    }
    const values = await resolveRecordValues(table.data.id, input.values, context.locale);
    if (!values.ok) return values;
    const result = await gridsService.record.external.put({
      tableId: table.data.id,
      identity: input.externalRef,
      operationScope,
      operationKey: context.idempotencyKey,
      requestHash,
      conflictKind: "capability",
      values: values.data.values,
      ifVersion: input.ifVersion,
      audit: input.audit,
      actorId: accessActorUser(access)?.id ?? null,
      dateConfig: await capabilityDateConfig(context.locale),
      viewer: actorViewerFor(access),
    });
    if (!result.ok) return result;
    const base = await gridsService.base.get(table.data.baseId);
    const outcome = result.data.replayed ? t.replayed : result.data.created ? t.created : result.data.changed ? t.updated : t.kept;
    return ok({
      data: {
        recordId: result.data.recordShortId,
        tableId: table.data.shortId,
        version: result.data.version,
        created: result.data.created,
        changed: result.data.changed,
        replayed: result.data.replayed,
      },
      summary: t.externalRecordOutcome({
        outcome,
        id: result.data.recordShortId,
        table: table.data.name,
        version: result.data.version,
      }),
      refs: [{ type: "grids.record", id: result.data.recordShortId }],
      ...(base ? { links: [{ rel: "open" as const, href: recordHref(base, table.data, result.data.recordShortId) }] } : {}),
    });
  });
};

const runRecordUpdate = async (input: z.infer<typeof RecordUpdateInputSchema>, context: CapabilityExecutionContext) => {
  return withCapabilityAudit(context, async () => {
    const t = capabilityMessagesFor(context.locale);
    if (Object.keys(input.values).length === 0) return fail(err.badInput(t.valuesRequired));
    const access = accessContext(context);
    const table = await requireTable(context.target?.id ?? "", access, "write", context.locale);
    if (!table.ok) return table;
    const record = await gridsService.record.getByShortId(input.recordId);
    if (!record || record.tableId !== table.data.id) return fail(notFoundError(t.recordNotFound));
    const values = await resolveRecordValues(table.data.id, input.values, context.locale);
    if (!values.ok) return values;
    const dateConfig = await capabilityDateConfig(context.locale);
    const result = await gridsService.record.update(
      table.data.id,
      record.id,
      values.data.values,
      accessActorUser(access)?.id ?? null,
      "direct",
      input.ifVersion,
      { dateConfig, viewer: actorViewerFor(access), audit: input.audit },
    );
    const fieldCount = Object.keys(input.values).length;
    return result.ok
      ? recordResult(
          result.data,
          table.data,
          t.updatedRecord({ count: fieldCount, id: result.data.shortId, table: table.data.name, version: result.data.version }),
          context.locale,
        )
      : result;
  });
};

const prepareViewCreate = async (input: z.infer<typeof ViewCreateInputSchema>, context: CapabilityExecutionContext) => {
  const base = await requireBase(context.target?.id ?? "", accessContext(context), context.locale);
  if (!base.ok) return base;
  const gate = await gateBaseAtAccess(accessContext(context), base.data.id, "admin");
  if (!gate.ok) return gate;
  const user = accessActorUser(accessContext(context));
  if (!input.shared && !user) return fail(err.forbidden(capabilityMessagesFor(context.locale).personalViewUserRequired));
  const current = await resolveGqlCurrentSource(base.data.id, input, context.locale);
  if (!current.ok) return current;
  const compiled = await canonicalGqlSourceForContext(await gqlRuntimeContext(context), base.data.id, {
    query: input.query,
    ...current.data,
  });
  if (!compiled.ok)
    return fail(
      err.badInput(
        compiled.diagnostics
          .map((item) => item.message)
          .join("; ")
          .slice(0, 1000),
      ),
    );
  return ok({ base: base.data, user, compiled });
};

export const gridsCapabilities = defineCapabilities({
  protocolVersion: 2,
  events: gridsEvents,
  presentation: gridsCapabilityPresentation,
  types: {
    ...dailyCapabilities.types,
    base: {
      title: "Grids base",
      description: "A permission-scoped Grids workspace.",
      icon: "ti ti-table",
      reader: "base.read",
      pages: ["/app/grids/:id"],
    },
    table: {
      title: "Grids Table",
      description: "A readable stored or Combined table in a base.",
      icon: "ti ti-table-column",
      reader: "table.read",
      container: "base",
      pages: ["/app/grids/:base/table/:id"],
    },
    view: {
      title: "Grids View",
      description: "A permission-scoped saved GQL data view.",
      icon: "ti ti-layout-list",
      reader: "view.read",
      container: "table",
      pages: ["/app/grids/:base/table/:table/view/:id"],
    },
    record: {
      title: "Grids Record",
      description: "One stable record in a Grids Table.",
      icon: "ti ti-row-insert-bottom",
      reader: "record.read",
      container: "table",
      pages: ["/app/grids/:base/table/:table?record=:id"],
    },
  },
  queries: {
    ...integrityCapabilities.queries,
    ...dailyCapabilities.queries,
    "base.search": {
      title: "Search Grids bases",
      description:
        "Find an accessible Grids base by name, description, or short ID when its ID is unknown. Use returned grids.base refs with base.read or their IDs with gql.context and GQL queries.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: { tags: [{ tag: "grid", title: "Grids", description: "Show Grids bases only.", aliases: ["grids"] }] },
      run: runBaseSearch,
    },
    "base.list": {
      title: "List Grids bases",
      description:
        "Normal entry for base-scoped Grids work. List accessible bases and use returned grids.base refs or IDs with base.read, gql.context, gql.preview, gql.execute, or gql.view.execute.",
      input: BaseListInputSchema,
      data: BaseListDataSchema,
      openWorld: false,
      run: runBaseList,
    },
    "base.read": {
      title: "Read Grids base",
      description: "Read one grids.base ref returned by base.list or base.search.",
      input: BaseReadInputSchema,
      data: BaseCapabilityDataSchema.extend({ view: CloudResourceReaderViewSchema }),
      openWorld: false,
      run: runBaseRead,
    },
    "table.read": {
      title: "Read Grids Table",
      description: "Read one grids.table ref returned by gql.context kind tables, including its base context and effective permission.",
      input: TableReadInputSchema,
      data: TableCapabilityDataSchema,
      openWorld: false,
      run: runTableRead,
    },
    "view.read": {
      title: "Read Grids View",
      description:
        "Read one grids.view ref returned by gql.context kind views; execute it with gql.view.execute using the same base target.",
      input: ViewReadInputSchema,
      data: ViewCapabilityDataSchema,
      openWorld: false,
      run: runViewRead,
    },
    "gql.context": {
      title: "Load Grids GQL context",
      description:
        "Load compact schema for a known task. If the source is unknown, request tables first; otherwise request fields with tableId. Options and list-columns need tableId and fieldId. List columns include typed constraints and calculations; follow pagination. Omit unused IDs, never send empty strings. Use includeWriteContext only before record writes. Views can feed gql.view.execute.",
      target: "base",
      input: GqlContextInputSchema,
      data: GqlContextDataSchema,
      openWorld: false,
      run: runGqlContext,
    },
    "gql.preview": {
      title: "Preview Grids GQL",
      description:
        "Validate permission-safe GQL after loading IDs with gql.context. Returns a small sample or actionable diagnostics without mutation; pass valid GQL unchanged to gql.execute.",
      target: "base",
      input: GqlPreviewInputSchema,
      data: GqlResultDataSchema,
      openWorld: false,
      run: runGqlPreview,
    },
    "gql.execute": {
      title: "Execute Grids GQL",
      description:
        "Execute permission-safe GQL after gql.context and normally gql.preview. Select only needed fields; returned grids.record refs can be opened with record.read, and nextCursor continues byte-bounded pages.",
      target: "base",
      input: GqlExecuteInputSchema,
      data: GqlResultDataSchema,
      openWorld: false,
      run: runGqlExecute,
    },
    "gql.view.execute": {
      title: "Execute saved Grids View",
      description:
        "Execute the exact saved query in the target base for a viewId returned by gql.context kind views. This is the direct saved-view path; use gql.execute for ad-hoc GQL and nextCursor for further pages.",
      target: "base",
      input: GqlViewExecuteInputSchema,
      data: GqlResultDataSchema,
      openWorld: false,
      run: runGqlViewExecute,
    },
    "record.read": {
      title: "Read Grids Record",
      description:
        "Read one grids.record ref returned by gql.execute, gql.preview, or a record Action. Returns metadata, finalization state, and the current version for record.update; use targeted gql.execute to read field values.",
      input: RecordReadInputSchema,
      data: RecordCapabilityDataSchema,
      openWorld: false,
      run: runRecordRead,
    },
  },
  actions: {
    ...integrityCapabilities.actions,
    ...dailyCapabilities.actions,
    "view.create": {
      policy: { ask: "app_asks" },
      title: "Save Grids query as View",
      description:
        "Save a reviewed GQL query as a new personal or shared View. Requires base admin access. Does not change tables or records. Never retry an uncertain result; inspect existing Views first.",
      target: "base",
      input: ViewCreateInputSchema,
      data: ViewCapabilityDataSchema,
      openWorld: false,
      destructive: false,
      idempotency: "required",
      review: async (input, context) => {
        const prepared = await prepareViewCreate(input, context);
        if (!prepared.ok) return prepared;
        const t = capabilityMessagesFor(context.locale);
        return ok(
          gridsActionReview(context, t.saveViewReview({ name: input.name }), {
            input,
            message: t.saveViewReview({ name: input.name }),
            // A personal View changes only the person's own list; a shared one shows to everyone in the Base and asks each time.
            ...(input.shared ? {} : { approvalScope: `personal-views:${prepared.data.compiled.tableId}` }),
            details: [
              { label: t.viewVisibility, value: input.shared ? t.sharedView : t.personalView },
              { label: "GQL", value: input.query.slice(0, 10000), display: "block" as const },
              ...(input.query.length > 10000 ? [{ label: "GQL (2)", value: input.query.slice(10000), display: "block" as const }] : []),
            ],
          }),
        );
      },
      run: async (input, context) => {
        return withCapabilityAudit(context, async () => {
          const prepared = await prepareViewCreate(input, context);
          if (!prepared.ok) return prepared;
          const { compiled, user } = prepared.data;
          const created = await gridsService.view.create(
            { tableId: compiled.tableId, name: input.name, source: compiled.source, ownerUserId: input.shared ? null : (user?.id ?? null) },
            user?.id ?? null,
            context.locale,
          );
          if (!created.ok) return created;
          const result = await runViewRead({ id: created.data.shortId }, context);
          return result.ok
            ? ok({ ...result.data, summary: capabilityMessagesFor(context.locale).savedView({ name: created.data.name }) })
            : result;
        });
      },
    },
    "record.create": {
      policy: { silent: "shared" },
      title: "Create Grids Record",
      description:
        "Create a single Grids Record. Call gql.context kind fields with includeWriteContext true first, then create once with values keyed by writable Field public ID. Select values use option IDs. Returns bounded metadata; read values with targeted GQL. Reuse the idempotency key only to retry the same create.",
      target: "table",
      input: RecordCreateInputSchema,
      data: RecordCapabilityDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      async review(input, context) {
        const table = await requireTable(context.target?.id ?? "", accessContext(context), "write", context.locale);
        if (!table.ok) return table;
        const values = await resolveRecordValues(table.data.id, input.values, context.locale);
        if (!values.ok) return values;
        const t = capabilityMessagesFor(context.locale);
        return ok(
          gridsActionReview(context, t.reviewCreateRecord({ table: table.data.name }), {
            input,
            message: t.reviewCreateRecord({ table: table.data.name }),
            approvalScope: `table:${context.target?.id}`,
            details: [{ label: t.table, value: table.data.name }, ...recordValuesReview(input.values, values.data.fields, context.locale)],
          }),
        );
      },
      run: runRecordCreate,
    },
    "record.upsert-external": {
      policy: { silent: "shared" },
      title: "Upsert external Grids Record",
      description:
        "Load gql.context kind fields with includeWriteContext true. Retry-safely bind provider + providerAccount + resourceKind + externalId to one Record. " +
        "The first request creates it; later updates require ifVersion and patch only supplied Field IDs.",
      target: "table",
      input: RecordExternalUpsertInputSchema,
      data: RecordExternalUpsertDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      review: async (input, context) => {
        const t = capabilityMessagesFor(context.locale);
        const access = accessContext(context);
        const table = await requireTable(context.target?.id ?? "", access, "write", context.locale);
        if (!table.ok) return table;
        const values = await resolveRecordValues(table.data.id, input.values, context.locale);
        if (!values.ok) return values;
        return ok(
          gridsActionReview(context, t.reviewExternalRecord({ table: table.data.name }), {
            input,
            message: t.reviewExternalRecord({ table: table.data.name }),
            approvalScope: `table:${context.target?.id}`,
            details: [
              { label: t.table, value: table.data.name },
              { label: t.provider, value: input.externalRef.provider },
              { label: t.providerAccount, value: input.externalRef.providerAccount },
              { label: t.resourceKind, value: input.externalRef.resourceKind },
              { label: t.externalId, value: input.externalRef.externalId },
              ...(input.ifVersion === undefined ? [] : [{ label: t.expectedVersion, value: String(input.ifVersion) }]),
              ...recordValuesReview(input.values, values.data.fields, context.locale, 14),
            ],
          }),
        );
      },
      run: runRecordExternalUpsert,
    },
    "record.update": {
      policy: { silent: "shared" },
      title: "Update Grids Record",
      description:
        "Load gql.context kind fields with includeWriteContext true for value and audit requirements, then record.read for ifVersion. Only supplied Field public IDs change; stale versions are rejected. Returns bounded metadata; read values with targeted GQL.",
      target: "table",
      input: RecordUpdateInputSchema,
      data: RecordCapabilityDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      review: async (input, context) => {
        const t = capabilityMessagesFor(context.locale);
        if (Object.keys(input.values).length === 0) return fail(err.badInput(t.valuesRequired));
        const access = accessContext(context);
        const table = await requireTable(context.target?.id ?? "", access, "write", context.locale);
        if (!table.ok) return table;
        const resolvedRecord = await gridsService.record.getByShortId(input.recordId);
        if (!resolvedRecord || resolvedRecord.tableId !== table.data.id) return fail(notFoundError(t.recordNotFound));
        const values = await resolveRecordValues(table.data.id, input.values, context.locale);
        if (!values.ok) return values;
        const dateConfig = await capabilityDateConfig(context.locale);
        const record = await gridsService.record.get(table.data.id, resolvedRecord.id, {
          dateConfig,
          viewer: actorViewerFor(access),
        });
        if (!record) return fail(notFoundError(t.recordNotFound));
        const base = await gridsService.base.get(table.data.baseId);
        return ok(
          gridsActionReview(context, t.reviewUpdateRecord({ table: table.data.name }), {
            input,
            message: t.reviewUpdateRecord({ table: table.data.name }),
            approvalScope: `table:${context.target?.id}`,
            details: [
              { label: t.table, value: table.data.name },
              { label: t.record, value: record.shortId },
              { label: t.currentVersion, value: String(record.version) },
              ...recordValuesReview(input.values, values.data.fields, context.locale),
            ],
            ...(base ? { links: [{ rel: "open" as const, href: recordHref(base, table.data, record.shortId) }] } : {}),
          }),
        );
      },
      run: runRecordUpdate,
    },
  },
});
