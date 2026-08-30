import { err, fail, ok } from "@k2b/stdlib";
import { type AuthContext, auth, expectUserBackedActor, jsonResponse, requiresAdmin, respond, v } from "@valentinkolb/cloud/server";
import { notificationBatches } from "@valentinkolb/cloud/services";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { createPagination, ErrorResponseSchema, PaginationQuerySchema, PaginationResponseSchema, parsePagination } from "@/contracts";

const BatchStatusSchema = z.enum(["draft", "ready", "running", "completed", "completed_with_errors", "failed", "cancelled"]);
const RecipientStatusSchema = z.enum(["pending", "sending", "sent", "skipped", "error"]);
const BatchIdParamSchema = z.object({ id: z.uuid() });
const BatchRecipientParamSchema = z.object({ id: z.uuid(), userId: z.uuid() });
const MAX_PAGE = 10_000;
const NotificationPaginationQuerySchema = z.object({
  ...PaginationQuerySchema.shape,
  page: z.coerce.number().int().positive().max(MAX_PAGE).optional().default(1),
});

const SelectionInputSchema = z
  .object({
    userIds: z.array(z.uuid()).max(5000).optional(),
    groupIds: z.array(z.uuid()).max(500).optional(),
  })
  .strict()
  .refine((selection) => (selection.userIds?.length ?? 0) > 0 || (selection.groupIds?.length ?? 0) > 0, {
    message: "Select at least one user or group.",
  });

const BatchSelectionResponseSchema = z
  .object({
    userIds: z.array(z.uuid()).optional(),
    groupIds: z.array(z.uuid()).optional(),
    mode: z.string().optional(),
    rules: z.array(z.string()).optional(),
    all: z.boolean().optional(),
    includeGroupMembers: z.boolean().optional(),
    accountManagers: z
      .object({
        mode: z.string().optional(),
        groupIds: z.array(z.string()).optional(),
        recursive: z.boolean().optional(),
      })
      .catchall(z.unknown())
      .optional(),
    providers: z.array(z.string()).optional(),
    profiles: z.array(z.string()).optional(),
  })
  .catchall(z.unknown());

const BatchSchema = z.object({
  id: z.string(),
  subject: z.string(),
  bodyMarkdown: z.string(),
  bodyHtml: z.string(),
  selection: BatchSelectionResponseSchema,
  selectionHash: z.string(),
  status: BatchStatusSchema,
  createdBy: z.string().nullable(),
  finalizedBy: z.string().nullable(),
  createdAt: z.string(),
  finalizedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  targetCount: z.number(),
  deliverableCount: z.number(),
  sentCount: z.number(),
  skippedCount: z.number(),
  errorCount: z.number(),
  lastError: z.string().nullable(),
});

const RecipientSchema = z.object({
  batchId: z.string(),
  userId: z.string(),
  recipient: z.string().nullable(),
  uid: z.string(),
  displayName: z.string(),
  provider: z.enum(["local", "ipa"]),
  profile: z.enum(["user", "guest"]),
  status: RecipientStatusSchema,
  notificationId: z.string().nullable(),
  error: z.string().nullable(),
  attemptCount: z.number(),
  sentAt: z.string().nullable(),
  updatedAt: z.string(),
});

const PreviewResponseSchema = z.object({
  targetCount: z.number(),
  deliverableCount: z.number(),
  skippedNoEmailCount: z.number(),
  duplicateCount: z.number(),
  recipientHash: z.string(),
});

const CreateBatchSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  bodyMarkdown: z.string().trim().min(1).max(100_000),
  selection: SelectionInputSchema,
});

const FinalizeBatchSchema = z.object({
  expectedSelectionHash: z.string().min(1),
  expectedDeliverableCount: z.number().int().nonnegative(),
  expectedRecipientHash: z.string().min(1),
});

const BatchListResponseSchema = z.object({
  batches: z.array(BatchSchema),
  pagination: PaginationResponseSchema,
});

const RecipientListResponseSchema = z.object({
  recipients: z.array(RecipientSchema),
  pagination: PaginationResponseSchema,
});

const FinalizeResponseSchema = z.object({
  batch: BatchSchema,
  jobId: z.string(),
});

const DeleteDraftResponseSchema = z.object({
  id: z.string(),
});

const QuerySchema = z.object({
  ...NotificationPaginationQuerySchema.shape,
  status: BatchStatusSchema.optional(),
});

const RecipientsQuerySchema = z.object({
  ...NotificationPaginationQuerySchema.shape,
  status: RecipientStatusSchema.optional(),
});

const app = new Hono<AuthContext>()
  .use(auth.requireRole("admin"))
  .get(
    "/batches",
    describeRoute({
      tags: ["Notifications"],
      summary: "List notification batches",
      description: "List admin-created notification batches and their delivery counters.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(BatchListResponseSchema, "Paginated notification batches"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("query", QuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const pagination = parsePagination(query);
      const page = await notificationBatches.list({
        page: pagination.page,
        perPage: pagination.perPage,
        status: query.status,
      });
      return respond(c, ok({ batches: page.items, pagination: createPagination(pagination, page.total) }));
    },
  )
  .post(
    "/batches/preview",
    describeRoute({
      tags: ["Notifications"],
      summary: "Preview notification recipients",
      description: "Resolve the recipient selection without creating or sending a batch.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(PreviewResponseSchema, "Resolved recipient preview"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("json", z.object({ selection: SelectionInputSchema })),
    async (c) => respond(c, ok(await notificationBatches.preview(c.req.valid("json").selection))),
  )
  .post(
    "/batches",
    describeRoute({
      tags: ["Notifications"],
      summary: "Create notification batch draft",
      description: "Create a draft batch. It is not sent until a later finalize request confirms the current recipient count.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(BatchSchema, "Notification batch draft"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("json", CreateBatchSchema),
    async (c) => {
      const actor = expectUserBackedActor(c);
      const body = c.req.valid("json");
      return respond(
        c,
        notificationBatches.createDraft({
          subject: body.subject,
          bodyMarkdown: body.bodyMarkdown,
          selection: body.selection,
          createdBy: actor.id,
        }),
      );
    },
  )
  .get(
    "/batches/:id",
    describeRoute({
      tags: ["Notifications"],
      summary: "Get notification batch",
      description: "Return one notification batch with delivery counters and selection.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(BatchSchema, "Notification batch"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "Batch not found"),
      },
    }),
    v("param", BatchIdParamSchema),
    async (c) => {
      const batch = await notificationBatches.get(c.req.valid("param").id);
      return respond(c, batch ? ok(batch) : fail(err.notFound("Notification batch not found")));
    },
  )
  .delete(
    "/batches/:id",
    describeRoute({
      tags: ["Notifications"],
      summary: "Delete notification batch draft",
      description: "Delete a draft notification batch. Finalized batches are immutable and cannot be deleted.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(DeleteDraftResponseSchema, "Deleted draft id"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "Batch not found"),
        409: jsonResponse(ErrorResponseSchema, "Only drafts can be deleted"),
      },
    }),
    v("param", BatchIdParamSchema),
    async (c) => respond(c, notificationBatches.removeDraft({ id: c.req.valid("param").id })),
  )
  .get(
    "/batches/:id/recipients",
    describeRoute({
      tags: ["Notifications"],
      summary: "List notification batch recipients",
      description: "List the recipient snapshot for a finalized batch.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(RecipientListResponseSchema, "Paginated recipients"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "Batch not found"),
      },
    }),
    v("param", BatchIdParamSchema),
    v("query", RecipientsQuerySchema),
    async (c) => {
      const params = c.req.valid("param");
      const query = c.req.valid("query");
      const batch = await notificationBatches.get(params.id);
      if (!batch) return respond(c, fail(err.notFound("Notification batch not found")));
      const pagination = parsePagination(query);
      const page = await notificationBatches.listRecipients({
        batchId: params.id,
        page: pagination.page,
        perPage: pagination.perPage,
        status: query.status,
      });
      return respond(c, ok({ recipients: page.items, pagination: createPagination(pagination, page.total) }));
    },
  )
  .post(
    "/batches/:id/finalize",
    describeRoute({
      tags: ["Notifications"],
      summary: "Finalize notification batch",
      description: "Persist the recipient snapshot and submit the async delivery job.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(FinalizeResponseSchema, "Finalized notification batch"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        409: jsonResponse(ErrorResponseSchema, "Batch or recipient count changed"),
      },
    }),
    v("param", BatchIdParamSchema),
    v("json", FinalizeBatchSchema),
    async (c) => {
      const actor = expectUserBackedActor(c);
      const params = c.req.valid("param");
      const body = c.req.valid("json");
      return respond(
        c,
        notificationBatches.finalize({
          id: params.id,
          actorUserId: actor.id,
          expectedSelectionHash: body.expectedSelectionHash,
          expectedDeliverableCount: body.expectedDeliverableCount,
          expectedRecipientHash: body.expectedRecipientHash,
        }),
      );
    },
  )
  .post(
    "/batches/:id/retry-failed",
    describeRoute({
      tags: ["Notifications"],
      summary: "Retry failed recipients",
      description: "Reset failed recipients to pending and submit another async delivery job.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(FinalizeResponseSchema, "Retry submitted"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "Batch not found"),
        409: jsonResponse(ErrorResponseSchema, "No failed deliverable recipients"),
      },
    }),
    v("param", BatchIdParamSchema),
    async (c) => respond(c, notificationBatches.retryFailed({ id: c.req.valid("param").id })),
  )
  .post(
    "/batches/:id/recipients/:userId/retry",
    describeRoute({
      tags: ["Notifications"],
      summary: "Retry one failed recipient",
      description: "Reset one failed recipient to pending and submit another async delivery job.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(FinalizeResponseSchema, "Retry submitted"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "Recipient not found"),
        409: jsonResponse(ErrorResponseSchema, "Recipient cannot be retried"),
      },
    }),
    v("param", BatchRecipientParamSchema),
    async (c) => {
      const params = c.req.valid("param");
      return respond(c, notificationBatches.retryRecipient({ id: params.id, userId: params.userId }));
    },
  );

export default app;
