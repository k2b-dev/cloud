import { sql } from "@k2b/cloud";
import { type CapabilityExecutionContext, defineCapabilities } from "@k2b/cloud/contracts";
import { get as settingsGet } from "@k2b/cloud/services/settings";
import { normalizeTimeZone } from "@k2b/cloud/shared";
import { err, fail, ok } from "@k2b/stdlib";
import { z } from "zod";
import { DocumentCapabilityDataSchema } from "./api/document-public-contracts";
import { documentActor, projectDocuments } from "./api/documents-api-shared";
import { accessActorUser, gateBaseAtAccess } from "./api/permissions";
import { PublicRecordFinalizationReadinessSchema, toPublicRecordFinalizationReadiness } from "./api/record-finalization";
import { DslQueryExecuteBodySchema, ShortIdSchema } from "./contracts";
import {
  AtomicRecordsDataSchema,
  AtomicRecordsInputSchema,
  CorrectionDraftInputSchema,
  FinalizeRecordInputSchema,
  IntegrityRecordDataSchema,
  RecordTargetSchema,
} from "./integrity-contracts";
import { gridsActionReview } from "./integrity-review";
import { parseGridsQueryDsl } from "./query-dsl/parser";
import { withCapabilityAudit } from "./service/audit";
import { persistDocumentData, resolveDocumentData } from "./service/document-data";
import { documentIssuanceService } from "./service/document-issuance";
import { DocumentQueryOutputSchema } from "./service/document-query-output";
import { DocumentSourceVersionsInputSchema } from "./service/document-source-versions";
import { buildTrustedGqlResolverContext } from "./service/gql-resolver-context";
import { resolvePublicId } from "./service/public-resources";
import { bindQueryData, captureQueryData } from "./service/query-capture";
import { inspect } from "./service/record-finalization";
import {
  changeRecordsAtomically,
  createCorrectionDraft,
  finalizeRecord,
  type IntegrityContext,
  integrityAttempt,
} from "./service/record-integrity";
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
    baseId: ShortIdSchema.describe("Writable Base public ID."),
    query: DslQueryExecuteBodySchema.shape.query.describe(
      "GQL query; captures its complete result, at most 10,000 rows within the document data budget.",
    ),
  })
  .strict();
const issueInput = z
  .object({
    baseId: ShortIdSchema.describe("Writable Base public ID."),
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
    baseId: ShortIdSchema.describe("Writable Base public ID."),
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
const finalizeReview = (input: z.infer<typeof FinalizeRecordInputSchema>, context: CapabilityExecutionContext) =>
  reviewed(
    context,
    "Close the current Record under its pinned finalization policy. Four-eyes approval remains required.",
    "Den aktuellen Datensatz nach der festgehaltenen Abschlussregel abschließen. Die Vier-Augen-Freigabe bleibt erforderlich.",
    input,
  );
const confirmationRequest = async (input: z.infer<typeof confirmationInput>, context: CapabilityExecutionContext) => {
  const baseId = await base(input.baseId, context);
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
      input: RecordTargetSchema,
      data: PublicRecordFinalizationReadinessSchema,
      openWorld: false,
      run: (input, context) =>
        integrityAttempt(async () => {
          const tableId = await resolvePublicId("table", input.tableId);
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
      input: AtomicRecordsInputSchema,
      data: AtomicRecordsDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      policy: { silent: "shared" },
      review: (input, context) => reviewed(context, "Change these Records atomically", "Diese Datensätze atomar ändern", input),
      run: (input, context) =>
        withCapabilityAudit(context, async () => {
          const result = await changeRecordsAtomically(input, await integrityContext(context));
          return result.ok
            ? ok({ data: result.data, refs: result.data.records.map((row) => ({ type: "grids.record", id: row.id })) })
            : result;
        }),
    },
    "record.close": {
      title: "Close Record",
      description:
        "Finalize under Direct policy or create a Four-eyes request. Requires current Record version and finalization policy revision. Always asks.",
      input: FinalizeRecordInputSchema,
      data: IntegrityRecordDataSchema.extend({ state: z.enum(["requested", "finalized"]) }),
      destructive: true,
      openWorld: false,
      idempotency: "required",
      policy: { ask: "cannot_undo" },
      review: finalizeReview,
      run: (input, context) =>
        withCapabilityAudit(context, async () => {
          const result = await finalizeRecord(input, await integrityContext(context), true);
          return result.ok ? ok({ data: result.data }) : result;
        }),
    },
    "record.finalize": {
      title: "Finalize Record",
      description:
        "Finalize one version-checked Record without changing the original Four-eyes rules. An independent eligible person must approve an existing request. Always asks.",
      input: FinalizeRecordInputSchema,
      data: IntegrityRecordDataSchema.extend({ state: z.enum(["requested", "finalized"]) }),
      destructive: true,
      openWorld: false,
      idempotency: "required",
      policy: { ask: "cannot_undo" },
      review: finalizeReview,
      run: (input, context) =>
        withCapabilityAudit(context, async () => {
          const result = await finalizeRecord(input, await integrityContext(context));
          return result.ok ? ok({ data: result.data }) : result;
        }),
    },
    "record.correction-draft": {
      title: "Create correction draft",
      description:
        "Create an editable correction or cancellation draft linked to a finalized original; never changes or reissues the original. Requires Base write access and current original version.",
      input: CorrectionDraftInputSchema,
      data: IntegrityRecordDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      policy: { silent: "shared" },
      review: (input, context) => reviewed(context, "Create this correction draft", "Diesen Korrekturentwurf erstellen", input),
      run: (input, context) =>
        withCapabilityAudit(context, async () => {
          const result = await createCorrectionDraft(input, await integrityContext(context));
          return result.ok ? ok({ data: result.data, refs: [{ type: "grids.record", id: result.data.id }] }) : result;
        }),
    },
    "document.capture": {
      title: "Capture document data",
      description:
        "Freeze a complete permission-checked GQL result in Grids, independent of any workflow. The immutable handle pins the values for document.issue. Truncated results are rejected.",
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
            const baseId = await base(input.baseId, context);
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
                operationKey: context.requestId,
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
            const baseId = await base(input.baseId, context);
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
