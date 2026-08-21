import { err, fail } from "@k2b/stdlib";
import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, getDateConfig, jsonResponse, respond, v } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { RecordOperationBodySchema, RecordPayloadSchema, RecordUpdateBodySchema, ShortIdSchema } from "../contracts";
import { gridsService } from "../service";
import { DEFAULT_MAX_FILE_SIZE_MB, getMaxFileSizeBytes } from "../service/file-limits";
import { fromPublicRecordValues, resolvePublicId, resolvePublicIds } from "../service/public-resources";
import { validateRecordQueryForTable } from "../service/query-validation";
import { ALL_RECORD_ACCESS } from "../service/record-access";
import * as recordFinalizationService from "../service/record-finalization";
import { PublicRecordRevisionPageSchema, toPublicRecordRevisionPage } from "./durable-history";
import { currentActorUserId, currentActorViewer, gateAt } from "./permissions";
import {
  PublicCombinedAuditPageSchema,
  PublicRecordHistoryEntrySchema,
  toPublicAuditEntries,
  toPublicCombinedAuditPage,
} from "./public-audit";
import {
  PublicGridFileSchema,
  PublicGridRecordSchema,
  PublicRecordCommentSchema,
  toPublicComment,
  toPublicComments,
  toPublicFile,
  toPublicFiles,
  toPublicRecord,
  toPublicRecords,
} from "./public-dto";
import { fromPublicExportBody, PublicExportBodySchema } from "./public-query";
import {
  PublicCloseSelectionPreviewInputSchema,
  PublicCloseSelectionPreviewSchema,
  PublicFinalizationRequestInputSchema,
  PublicFinalizationResolutionInputSchema,
  PublicRecordFinalizationReadinessSchema,
  PublicRecordFinalizationRequestSchema,
  toPublicRecordFinalizationReadiness,
} from "./record-finalization";
import { PublicReferencedByPageSchema, toPublicReferencedByPage } from "./referenced-by";
import { internalIdParam, requirePublicIdParam, requireStoredPublicIdParam } from "./route-params";

const RecordImportBodySchema = z.object({
  items: z.array(RecordPayloadSchema).min(1).max(500),
});

const RecordImportResponseSchema = z.object({
  items: z.array(PublicGridRecordSchema),
});

const ExternalRecordIdentitySchema = z
  .object({
    provider: z.string().min(1).max(100).refine((value) => value.trim() === value, "Must not start or end with whitespace"),
    providerAccount: z.string().min(1).max(200).refine((value) => value.trim() === value, "Must not start or end with whitespace"),
    resourceKind: z.string().min(1).max(100).refine((value) => value.trim() === value, "Must not start or end with whitespace"),
    externalId: z.string().min(1).max(500).refine((value) => value.trim() === value, "Must not start or end with whitespace"),
  })
  .strict();
const ExternalRecordPutBodySchema = z
  .object({
    externalRef: ExternalRecordIdentitySchema,
    values: RecordPayloadSchema,
    ifVersion: z.number().int().positive().optional(),
    audit: RecordUpdateBodySchema.shape.audit,
  })
  .strict();
const ExternalRecordPutResponseSchema = z
  .object({
    record: PublicGridRecordSchema,
    created: z.boolean(),
    changed: z.boolean(),
    replayed: z.boolean(),
  })
  .strict();

const RecordCommentBodySchema = z.object({ body: z.string().max(10_000) }).strict();
const RecordCommentPermissionsSchema = z.object({
  actorUserId: z.string().uuid().nullable(),
  canWrite: z.boolean(),
  canModerate: z.boolean(),
});
const RecordCommentPageSchema = z.object({
  items: z.array(PublicRecordCommentSchema),
  nextCursor: z.string().nullable(),
  permissions: RecordCommentPermissionsSchema,
});
const RecordCommentListQuerySchema = z
  .object({
    cursor: z.string().max(2_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const ReferencedByQuerySchema = z
  .object({
    cursor: z.string().max(2_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    relationFieldId: ShortIdSchema.optional(),
  })
  .strict();

const DurableHistoryQuerySchema = z
  .object({
    cursor: ShortIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

const CombinedAuditQuerySchema = z.object({
  recordId: ShortIdSchema.optional(),
  sourceRef: z.string().max(20).optional(),
  action: z.enum(["created", "updated", "deleted", "restored", "imported"]).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(2_000).optional(),
});

const parseIfMatchVersion = (value: string | undefined): number | null | undefined => {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) ? version : null;
};

export const recordsRoutes = new Hono<AuthContext>()

  // Record listing is served by the unified table query endpoint so
  // list, search, filter, sort, group, and aggregate reads share one
  // backend contract.

  .post(
    "/:tableId/finalization/preview",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Preview Finalization for an exact Record selection",
      responses: {
        200: jsonResponse(PublicCloseSelectionPreviewSchema, "Finalization readiness for the selected Records"),
        400: jsonResponse(ErrorResponseSchema, "Invalid selection"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Table not found"),
      },
    }),
    v("json", PublicCloseSelectionPreviewInputSchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const recordIds = c.req.valid("json").recordIds;
      const internalIds = await resolvePublicIds("record", recordIds);
      const items = [] as z.infer<typeof PublicCloseSelectionPreviewSchema>["items"];
      let cursor = 0;
      const worker = async () => {
        while (!c.req.raw.signal.aborted && cursor < recordIds.length) {
          const index = cursor++;
          const recordId = recordIds[index]!;
          const internalRecordId = internalIds.get(recordId);
          if (!internalRecordId) {
            items[index] = { ok: false, recordId, reason: "Record not found." };
            continue;
          }
          const result = await recordFinalizationService.inspect({
            tableId,
            recordId: internalRecordId,
            actorId: currentActorUserId(c),
            recordAccess: ALL_RECORD_ACCESS,
          });
          items[index] = result.ok
            ? {
                ok: true,
                recordId,
                enabled: result.data.enabled,
                mode: result.data.mode,
                policyRevision: result.data.policyRevision,
                finalized: result.data.finalized,
                pendingRequest: result.data.request?.status === "pending",
                missingFieldNames: result.data.missing.map((field) => field.fieldName),
              }
            : { ok: false, recordId, reason: result.error.message };
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, recordIds.length) }, () => worker()));
      return c.json(PublicCloseSelectionPreviewSchema.parse({ items }));
    },
  )

  .get(
    "/:tableId/:recordId/versions",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "List durable record versions",
      responses: {
        200: jsonResponse(PublicRecordRevisionPageSchema, "Durable record versions"),
        400: jsonResponse(ErrorResponseSchema, "Invalid cursor"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Record not found"),
      },
    }),
    v("query", DurableHistoryQuerySchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "read");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const visibleRecord = await gridsService.record.get(tableId, recordId, { recordAccess: ALL_RECORD_ACCESS });
      if (!visibleRecord) return c.json({ message: "Record not found" }, 404);
      const query = c.req.valid("query");
      const result = await gridsService.record.durableHistory.list({ tableId, recordId, ...query });
      return result.ok ? c.json(await toPublicRecordRevisionPage(result.data)) : respond(c, () => Promise.resolve(result));
    },
  )

  .get(
    "/:tableId/:recordId/versions/:revisionId/files/:fileId",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    requirePublicIdParam("fileId", "file", "File"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Download a file retained by a durable record version",
      responses: {
        200: { description: "Exact historical file bytes" },
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Historical file not found"),
      },
    }),
    async (c) => {
      const revisionId = ShortIdSchema.safeParse(c.req.param("revisionId"));
      if (!revisionId.success) return c.json({ message: "Historical file not found" }, 404);
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "read");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const visibleRecord = await gridsService.record.get(tableId, recordId, { recordAccess: ALL_RECORD_ACCESS });
      if (!visibleRecord) return c.json({ message: "Record not found" }, 404);
      const result = await gridsService.record.durableHistory.getFileContent({
        tableId,
        recordId,
        revisionShortId: revisionId.data,
        fileId: internalIdParam(c, "fileId")!,
      });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      c.header("Content-Type", result.data.mimeType);
      c.header("Content-Length", String(result.data.sizeBytes));
      c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(result.data.filename)}`);
      c.header("ETag", `\"${result.data.sha256}\"`);
      c.header("Cache-Control", "private, no-store");
      return c.body(Uint8Array.from(result.data.bytes).buffer);
    },
  )

  .get(
    "/:tableId/:recordId/finalization",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Inspect whether a record is ready to finalize",
      responses: {
        200: jsonResponse(PublicRecordFinalizationReadinessSchema, "Record finalization readiness"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await recordFinalizationService.inspect({
        tableId,
        recordId,
        actorId: currentActorUserId(c),
        recordAccess: ALL_RECORD_ACCESS,
      });
      return result.ok ? c.json(await toPublicRecordFinalizationReadiness(result.data)) : respond(c, () => Promise.resolve(result));
    },
  )

  .post(
    "/:tableId/:recordId/finalize",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Finalize a record and make it immutable",
      responses: {
        200: jsonResponse(PublicGridRecordSchema, "Finalized record"),
        400: jsonResponse(ErrorResponseSchema, "Record is incomplete or finalization is disabled"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Concurrent change"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.record.finalization.finalize({
        tableId,
        recordId,
        actorId: currentActorUserId(c),
        origin: "direct",
        recordAccess: ALL_RECORD_ACCESS,
        dateConfig: await getDateConfig(c),
      });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      const fields = await gridsService.field.listByTable(tableId);
      return c.json(await toPublicRecord(result.data, fields));
    },
  )

  .post(
    "/:tableId/:recordId/finalization/request",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    v("json", PublicFinalizationRequestInputSchema),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Request Four-eyes Finalization",
      responses: {
        200: jsonResponse(PublicRecordFinalizationRequestSchema, "Finalization request"),
        400: jsonResponse(ErrorResponseSchema, "Record is not ready"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Request conflict"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await recordFinalizationService.requestFinalization({
        tableId,
        recordId,
        actorId: currentActorUserId(c),
        comment: c.req.valid("json").comment,
        recordAccess: ALL_RECORD_ACCESS,
      });
      return result.ok ? c.json(result.data) : respond(c, () => Promise.resolve(result));
    },
  )

  .post(
    "/:tableId/:recordId/finalization/approve",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    v("json", PublicFinalizationResolutionInputSchema),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Approve a Four-eyes Finalization request and finalize the Record",
      responses: {
        200: jsonResponse(PublicGridRecordSchema, "Finalized record"),
        400: jsonResponse(ErrorResponseSchema, "Record is not ready"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Request or Record changed"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await recordFinalizationService.approveFinalization({
        tableId,
        recordId,
        actorId: currentActorUserId(c),
        requestId: c.req.valid("json").requestId,
        comment: c.req.valid("json").comment,
        recordAccess: ALL_RECORD_ACCESS,
        dateConfig: await getDateConfig(c),
      });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      const fields = await gridsService.field.listByTable(tableId);
      return c.json(await toPublicRecord(result.data, fields));
    },
  )

  .post(
    "/:tableId/:recordId/finalization/reject",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    v("json", PublicFinalizationResolutionInputSchema),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Reject a Four-eyes Finalization request",
      responses: {
        200: jsonResponse(PublicRecordFinalizationRequestSchema, "Rejected Finalization request"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Request changed"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await recordFinalizationService.rejectFinalization({
        tableId,
        recordId,
        actorId: currentActorUserId(c),
        requestId: c.req.valid("json").requestId,
        comment: c.req.valid("json").comment,
      });
      return result.ok ? c.json(result.data) : respond(c, () => Promise.resolve(result));
    },
  )

  .get(
    "/:tableId/:recordId/referenced-by",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "List live records that reference this record",
      responses: {
        200: jsonResponse(PublicReferencedByPageSchema, "Incoming record references"),
        400: jsonResponse(ErrorResponseSchema, "Invalid cursor or filter"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Record not found"),
      },
    }),
    v("query", ReferencedByQuerySchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "read");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const query = c.req.valid("query");
      const result = await gridsService.record.listReferencedBy({
        targetTableId: tableId,
        targetRecordId: recordId,
        relationFieldId: query.relationFieldId,
        cursor: query.cursor,
        limit: query.limit,
        recordAccess: ALL_RECORD_ACCESS,
      });
      return result.ok ? c.json(toPublicReferencedByPage(result.data)) : respond(c, () => Promise.resolve(result));
    },
  )

  .get(
    "/:tableId/:recordId/files/:fieldId",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    requirePublicIdParam("fieldId", "field", "Field"),
    describeRoute({
      tags: ["Grids:File"],
      summary: "List files for a file field on a record",
      responses: {
        200: jsonResponse(z.object({ items: z.array(PublicGridFileSchema) }), "Files"),
        400: jsonResponse(ErrorResponseSchema, "Invalid file field"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Publication changed"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const fieldId = internalIdParam(c, "fieldId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "read");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const visibleRecord = await gridsService.record.get(tableId, recordId, { recordAccess: ALL_RECORD_ACCESS });
      if (!visibleRecord) return c.json({ message: "Record not found" }, 404);
      const result = await gridsService.file.listForRecordField({ tableId, recordId, fieldId });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.json({ items: await toPublicFiles(result.data) });
    },
  )

  .post(
    "/:tableId/:recordId/files/:fieldId",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    requirePublicIdParam("fieldId", "field", "Field"),
    describeRoute({
      tags: ["Grids:File"],
      summary: "Upload a file to a record file field",
      description: `Stores a small file directly in Postgres bytea. Max size is configurable via \`grids.max_file_size_mb\` (default ${DEFAULT_MAX_FILE_SIZE_MB} MB).`,
      responses: {
        200: jsonResponse(PublicGridFileSchema, "Uploaded file metadata"),
        400: jsonResponse(ErrorResponseSchema, "Invalid upload"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Record is finalized"),
        413: jsonResponse(ErrorResponseSchema, "File too large"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const fieldId = internalIdParam(c, "fieldId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const visibleRecord = await gridsService.record.get(tableId, recordId, { recordAccess: ALL_RECORD_ACCESS });
      if (!visibleRecord) return c.json({ message: "Record not found" }, 404);

      const form = await c.req.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) return respond(c, fail(err.badInput("Missing 'file' field")));

      const maxBytes = await getMaxFileSizeBytes();
      if (file.size > maxBytes) {
        return c.json({ message: `File exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit` }, 413);
      }

      const result = await gridsService.file.upload({
        tableId,
        recordId,
        fieldId,
        filename: file.name || "untitled",
        mimeType: file.type || "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
        userId: currentActorUserId(c),
        origin: "direct",
      });
      return result.ok ? c.json(await toPublicFile(result.data)) : respond(c, () => Promise.resolve(result));
    },
  )

  .put(
    "/:tableId/:recordId/files/:fieldId/:fileId",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    requirePublicIdParam("fieldId", "field", "Field"),
    requirePublicIdParam("fileId", "file", "File"),
    describeRoute({
      tags: ["Grids:File"],
      summary: "Replace a record file attachment",
      description: "Atomically replaces the current attachment while preserving protected references to the previous file.",
      responses: {
        200: jsonResponse(PublicGridFileSchema, "Replacement file metadata"),
        400: jsonResponse(ErrorResponseSchema, "Invalid replacement"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Record is finalized"),
        413: jsonResponse(ErrorResponseSchema, "File too large"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const fieldId = internalIdParam(c, "fieldId")!;
      const fileId = internalIdParam(c, "fileId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const visibleRecord = await gridsService.record.get(tableId, recordId, { recordAccess: ALL_RECORD_ACCESS });
      if (!visibleRecord) return c.json({ message: "Record not found" }, 404);

      const form = await c.req.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) return respond(c, fail(err.badInput("Missing 'file' field")));

      const maxBytes = await getMaxFileSizeBytes();
      if (file.size > maxBytes) {
        return c.json({ message: `File exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit` }, 413);
      }

      const result = await gridsService.file.replace({
        tableId,
        recordId,
        fieldId,
        fileId,
        filename: file.name || "untitled",
        mimeType: file.type || "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
        userId: currentActorUserId(c),
        origin: "direct",
      });
      return result.ok ? c.json(await toPublicFile(result.data)) : respond(c, () => Promise.resolve(result));
    },
  )

  .get(
    "/:tableId/:recordId/files/:fieldId/:fileId/content",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    requirePublicIdParam("fieldId", "field", "Field"),
    requirePublicIdParam("fileId", "file", "File"),
    describeRoute({
      tags: ["Grids:File"],
      summary: "Download a file field blob",
      responses: {
        200: { description: "File content" },
        400: jsonResponse(ErrorResponseSchema, "Invalid file field"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Publication changed"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const fieldId = internalIdParam(c, "fieldId")!;
      const fileId = internalIdParam(c, "fileId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "read");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const visibleRecord = await gridsService.record.get(tableId, recordId, { recordAccess: ALL_RECORD_ACCESS });
      if (!visibleRecord) return c.json({ message: "Record not found" }, 404);
      const result = await gridsService.file.getContent({ tableId, recordId, fieldId, fileId });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      const file = result.data;
      const buffer = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer;
      const inline = c.req.query("inline") === "true";
      return new Response(new Blob([buffer], { type: file.mimeType }), {
        headers: {
          "Content-Type": file.mimeType,
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(file.filename)}"`,
          "Cache-Control": "private, max-age=300",
        },
      });
    },
  )

  .delete(
    "/:tableId/:recordId/files/:fieldId/:fileId",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    requirePublicIdParam("fieldId", "field", "Field"),
    requirePublicIdParam("fileId", "file", "File"),
    describeRoute({
      tags: ["Grids:File"],
      summary: "Remove a file attachment from the current record",
      responses: {
        204: { description: "Removed from the current record" },
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Record is finalized"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const fieldId = internalIdParam(c, "fieldId")!;
      const fileId = internalIdParam(c, "fileId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const visibleRecord = await gridsService.record.get(tableId, recordId, { recordAccess: ALL_RECORD_ACCESS });
      if (!visibleRecord) return c.json({ message: "Record not found" }, 404);
      const result = await gridsService.file.remove({
        tableId,
        recordId,
        fieldId,
        fileId,
        userId: currentActorUserId(c),
        origin: "direct",
      });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.body(null, 204);
    },
  )

  .post(
    "/by-table/:tableId",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Create a record",
      responses: {
        201: jsonResponse(PublicGridRecordSchema, "Created"),
        400: jsonResponse(ErrorResponseSchema, "Invalid input"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Conflict"),
      },
    }),
    v("json", RecordPayloadSchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const fields = await gridsService.field.listByTable(tableId);
      const values = await fromPublicRecordValues(tableId, c.req.valid("json"));
      if (!values.ok) return c.json({ message: values.error.message }, values.error.status);
      const result = await gridsService.record.create(tableId, values.data, currentActorUserId(c), "direct", {
        dateConfig: await getDateConfig(c),
        viewer: currentActorViewer(c),
        recordAccess: ALL_RECORD_ACCESS,
      });
      return result.ok
        ? c.json(await toPublicRecord(result.data, fields), 201)
        : c.json({ message: result.error.message }, result.error.status);
    },
  )

  .put(
    "/by-table/:tableId/external",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Create or conditionally update a Record by scoped external identity",
      description:
        "The external identity is provider + providerAccount + resourceKind + externalId. " +
        "Idempotency-Key identifies one retry-safe request; updating an existing binding also requires ifVersion.",
      parameters: [
        {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          description: "Stable key for this logical external Record request and its uncertain retries.",
          schema: { type: "string", minLength: 1, maxLength: 200 },
        },
      ],
      responses: {
        200: jsonResponse(ExternalRecordPutResponseSchema, "Existing external Record resolved or updated"),
        201: jsonResponse(ExternalRecordPutResponseSchema, "External Record created"),
        400: jsonResponse(ErrorResponseSchema, "Invalid input or idempotency key"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Identity, version, or idempotency conflict"),
      },
    }),
    v("json", ExternalRecordPutBodySchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const operationKey = c.req.header("Idempotency-Key")?.trim();
      if (!operationKey || operationKey.length > 200) {
        return c.json({ message: "Idempotency-Key must contain between 1 and 200 characters" }, 400);
      }
      const body = c.req.valid("json");
      const fields = await gridsService.field.listByTable(tableId);
      const values = await fromPublicRecordValues(tableId, body.values);
      if (!values.ok) return c.json({ message: values.error.message }, values.error.status);
      const result = await gridsService.record.external.put({
        tableId,
        identity: body.externalRef,
        operationKey,
        values: values.data,
        ifVersion: body.ifVersion,
        audit: body.audit,
        actorId: currentActorUserId(c),
        dateConfig: await getDateConfig(c),
        viewer: currentActorViewer(c),
        recordAccess: ALL_RECORD_ACCESS,
      });
      if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
      const response = ExternalRecordPutResponseSchema.parse({
        record: await toPublicRecord(result.data.record, fields),
        created: result.data.created,
        changed: result.data.changed,
        replayed: result.data.replayed,
      });
      return c.json(response, result.data.created && !result.data.replayed ? 201 : 200);
    },
  )

  .post(
    "/by-table/:tableId/import",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Import records atomically from JSON payloads",
      description: "Creates all records in one transaction. The body is { items: [recordPayload, ...] }.",
      responses: {
        201: jsonResponse(RecordImportResponseSchema, "Imported records"),
        400: jsonResponse(ErrorResponseSchema, "Invalid input"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Conflict"),
      },
    }),
    v("json", RecordImportBodySchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const fields = await gridsService.field.listByTable(tableId);
      const items = await Promise.all(c.req.valid("json").items.map((item) => fromPublicRecordValues(tableId, item)));
      const invalid = items.find((item) => !item.ok);
      if (invalid && !invalid.ok) return c.json({ message: invalid.error.message }, invalid.error.status);
      const result = await gridsService.record.createMany(
        tableId,
        items.flatMap((item) => (item.ok ? [item.data] : [])),
        currentActorUserId(c),
        "direct",
        {
          dateConfig: await getDateConfig(c),
          viewer: currentActorViewer(c),
          recordAccess: ALL_RECORD_ACCESS,
        },
      );
      return result.ok
        ? c.json({ items: await toPublicRecords(result.data, fields) }, 201)
        : c.json({ message: result.error.message }, result.error.status);
    },
  )

  .get(
    "/:tableId/:recordId",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Get a record",
      responses: {
        200: jsonResponse(PublicGridRecordSchema, "Record"),
        400: jsonResponse(ErrorResponseSchema, "Invalid query"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    v(
      "query",
      z
        .object({
          includeDeleted: z.enum(["true"]).optional(),
          deletedOnly: z.enum(["true"]).optional(),
        })
        .refine((query) => !(query.includeDeleted && query.deletedOnly), "Choose includeDeleted or deletedOnly, not both"),
    ),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "read");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const record = await gridsService.record.get(tableId, recordId, {
        dateConfig: await getDateConfig(c),
        viewer: currentActorViewer(c),
        recordAccess: ALL_RECORD_ACCESS,
        deleted: c.req.valid("query").deletedOnly ? "only" : c.req.valid("query").includeDeleted ? "include" : "live",
      });
      if (!record) return c.json({ message: "Record not found" }, 404);
      const fields = await gridsService.field.listByTable(tableId);
      return c.json(await toPublicRecord(record, fields));
    },
  )

  .patch(
    "/:tableId/:recordId",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Update a record (optimistic lock via If-Match: <version>)",
      responses: {
        200: jsonResponse(PublicGridRecordSchema, "Updated"),
        400: jsonResponse(ErrorResponseSchema, "Invalid input or missing audit answers"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Version conflict"),
      },
    }),
    v("json", RecordUpdateBodySchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const ifMatchVersion = parseIfMatchVersion(c.req.header("If-Match"));
      if (ifMatchVersion === null) return c.json({ message: "If-Match must contain a positive integer Record version" }, 400);
      const body = c.req.valid("json");
      const fields = await gridsService.field.listByTable(tableId);
      const values = await fromPublicRecordValues(tableId, body.values);
      if (!values.ok) return c.json({ message: values.error.message }, values.error.status);
      const result = await gridsService.record.update(tableId, recordId, values.data, currentActorUserId(c), "direct", ifMatchVersion, {
        dateConfig: await getDateConfig(c),
        viewer: currentActorViewer(c),
        audit: body.audit,
        recordAccess: ALL_RECORD_ACCESS,
      });
      return result.ok ? c.json(await toPublicRecord(result.data, fields)) : c.json({ message: result.error.message }, result.error.status);
    },
  )

  .post(
    "/:tableId/:recordId/trash",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Move a record to trash",
      responses: {
        204: { description: "Moved to trash" },
        400: jsonResponse(ErrorResponseSchema, "Invalid input or missing audit answers"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Record is finalized or changed concurrently"),
      },
    }),
    v("json", RecordOperationBodySchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.record.softDelete(
        tableId,
        recordId,
        currentActorUserId(c),
        "direct",
        c.req.valid("json").audit,
        ALL_RECORD_ACCESS,
      );
      if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
      return c.body(null, 204);
    },
  )

  .post(
    "/by-table/:tableId/export",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Export records with configurable fields and relation expansion",
      responses: {
        200: { description: "Export body — Content-Type matches format" },
        400: jsonResponse(ErrorResponseSchema, "Invalid input"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Publication changed"),
      },
    }),
    v("json", PublicExportBodySchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "read");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));

      const publicBody = c.req.valid("json");
      const body = await fromPublicExportBody(tableId, publicBody);
      if (!body.ok) return c.json({ message: body.error.message }, body.error.status);
      const queryValid = await validateRecordQueryForTable(tableId, body.data.query);
      if (!queryValid.ok) return c.json({ message: queryValid.error.message }, queryValid.error.status);
      if ((body.data.query.groupBy?.length ?? 0) > 0) {
        return c.json({ message: "Grouped exports are not supported yet. Clear Group before exporting." }, 400);
      }
      const result = await gridsService.exporter.exportRecords({
        tableId,
        format: body.data.format,
        query: body.data.query,
        fields: body.data.fields,
        csv: body.data.csv,
        markdown: body.data.markdown,
        dateConfig: await getDateConfig(c),
        viewer: currentActorViewer(c),
        recordAccess: ALL_RECORD_ACCESS,
      });
      if (!result.ok) return c.json({ message: result.error.message }, result.error.status);

      return new Response(result.data.body, {
        status: 200,
        headers: {
          "Content-Type": result.data.contentType,
          "Content-Disposition": `attachment; filename="${result.data.filename}"`,
        },
      });
    },
  )

  // Grouping and aggregate reads are served by the unified table query
  // endpoint, keeping all record-read semantics in one place.

  .get(
    "/by-table/:tableId/audit",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Browse a Combined table's published record audit",
      description:
        "Returns a cursor-paginated audit feed projected through the active Combined publication. " +
        "Only canonical fields, safe source labels, actors, lifecycle actions, and declared audit answers are returned.",
      responses: {
        200: jsonResponse(PublicCombinedAuditPageSchema, "Published Combined audit page"),
        400: jsonResponse(ErrorResponseSchema, "Invalid filter"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Publication changed"),
      },
    }),
    v("query", CombinedAuditQuerySchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table || table.kind !== "federated") return c.json({ message: "Combined table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "read");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const query = c.req.valid("query");
      const resolvedRecordId = query.recordId ? await resolvePublicId("record", query.recordId) : undefined;
      if (query.recordId && !resolvedRecordId) return c.json({ message: "Record not found" }, 404);
      const result = await gridsService.audit.combined.list({
        tableId,
        ...query,
        recordId: resolvedRecordId ?? undefined,
        recordAccess: ALL_RECORD_ACCESS,
      });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      const fields = await gridsService.field.listByTable(tableId);
      return c.json(await toPublicCombinedAuditPage(result.data, fields));
    },
  )

  .post(
    "/:tableId/:recordId/restore",
    requirePublicIdParam("tableId", "table", "Table"),
    requireStoredPublicIdParam("recordId", "record", "Record"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Restore a soft-deleted record",
      responses: {
        204: { description: "Restored" },
        400: jsonResponse(ErrorResponseSchema, "Invalid input or missing audit answers"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Conflict"),
      },
    }),
    v("json", RecordOperationBodySchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.record.restore(
        tableId,
        recordId,
        currentActorUserId(c),
        "direct",
        c.req.valid("json").audit,
        ALL_RECORD_ACCESS,
      );
      if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
      return c.body(null, 204);
    },
  )

  .get(
    "/:tableId/:recordId/comments",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "List comments for a record",
      responses: {
        200: jsonResponse(RecordCommentPageSchema, "Comments"),
        400: jsonResponse(ErrorResponseSchema, "Invalid cursor"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    v("query", RecordCommentListQuerySchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "read");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.record.comments.list({
        baseId: table.baseId,
        tableId,
        recordId,
        recordAccess: ALL_RECORD_ACCESS,
        ...c.req.valid("query"),
      });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.json({
        ...result.data,
        items: toPublicComments(result.data.items),
        permissions: {
          actorUserId: currentActorUserId(c),
          canWrite: gridsService.permission.hasAtLeast(gate.data, "write"),
          canModerate: gate.data === "admin",
        },
      });
    },
  )

  .post(
    "/:tableId/:recordId/comments",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Add a comment to a record",
      responses: {
        201: jsonResponse(PublicRecordCommentSchema, "Created comment"),
        400: jsonResponse(ErrorResponseSchema, "Invalid comment"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    v("json", RecordCommentBodySchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.record.comments.create({
        baseId: table.baseId,
        tableId,
        recordId,
        actorUserId: currentActorUserId(c),
        body: c.req.valid("json").body,
        recordAccess: ALL_RECORD_ACCESS,
      });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.json(toPublicComment(result.data), 201);
    },
  )

  .patch(
    "/:tableId/:recordId/comments/:commentId",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    requirePublicIdParam("commentId", "comment", "Comment"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Edit a record comment",
      responses: {
        200: jsonResponse(PublicRecordCommentSchema, "Updated comment"),
        400: jsonResponse(ErrorResponseSchema, "Invalid comment"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    v("json", RecordCommentBodySchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const record = await gridsService.record.get(tableId, recordId, { recordAccess: ALL_RECORD_ACCESS });
      if (!record) return c.json({ message: "Record not found" }, 404);
      const result = await gridsService.record.comments.update({
        baseId: table.baseId,
        tableId,
        recordId,
        commentId: internalIdParam(c, "commentId")!,
        actorUserId: currentActorUserId(c),
        canModerate: gate.data === "admin",
        body: c.req.valid("json").body,
        recordAccess: ALL_RECORD_ACCESS,
      });
      return result.ok ? c.json(toPublicComment(result.data)) : c.json({ message: result.error.message }, result.error.status);
    },
  )

  .delete(
    "/:tableId/:recordId/comments/:commentId",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    requirePublicIdParam("commentId", "comment", "Comment"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "Delete a record comment",
      responses: {
        204: { description: "Deleted" },
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "write");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const record = await gridsService.record.get(tableId, recordId, { recordAccess: ALL_RECORD_ACCESS });
      if (!record) return c.json({ message: "Record not found" }, 404);
      const result = await gridsService.record.comments.remove({
        baseId: table.baseId,
        tableId,
        recordId,
        commentId: internalIdParam(c, "commentId")!,
        actorUserId: currentActorUserId(c),
        canModerate: gate.data === "admin",
        recordAccess: ALL_RECORD_ACCESS,
      });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.body(null, 204);
    },
  )

  .get(
    "/:tableId/:recordId/audit",
    requirePublicIdParam("tableId", "table", "Table"),
    requirePublicIdParam("recordId", "record", "Record"),
    describeRoute({
      tags: ["Grids:Record"],
      summary: "List audit entries for a record",
      description:
        "Returns the most-recent 50 entries from grids.audit_log for the record, " +
        "with the actor's display name resolved. Newest first.",
      responses: {
        200: jsonResponse(z.object({ items: z.array(PublicRecordHistoryEntrySchema) }), "Audit entries"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const recordId = internalIdParam(c, "recordId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: "Table not found" }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "read");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const visibleRecord = await gridsService.record.get(tableId, recordId, { recordAccess: ALL_RECORD_ACCESS });
      if (!visibleRecord) return c.json({ message: "Record not found" }, 404);
      const items = await gridsService.audit.listByRecord(tableId, recordId, 50);
      const fields = await gridsService.field.listByTable(tableId);
      return c.json({ items: await toPublicAuditEntries(items, fields) });
    },
  );

const app = new Hono<AuthContext>().use(auth.requireRole("authenticated")).route("/", recordsRoutes);
export default app;
