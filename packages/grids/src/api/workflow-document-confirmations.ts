import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { type AuthContext, getDateConfig, getLocale, jsonResponse, respond } from "@k2b/cloud/server";
import { dates, err, fail, ok } from "@k2b/stdlib";
import type { SQL } from "bun";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import { DatevBatchSchema } from "../document-profiles/datev-csv-contracts";
import { SepaBatchSchema, sepaPreviewWarnings } from "../document-profiles/sepa-xml-contracts";
import { documentIssuanceService } from "../service/document-issuance";
import { documentServiceText } from "../service/document-messages";
import { canAccessWorkflowRunTable, canExecuteRun, documentActorForScope } from "../service/workflow-action-scope";
import { authorizeWorkflowBase } from "../service/workflow-authorization";
import { getWorkflowRunScope } from "../service/workflow-runs";
import { apiMessages } from "./messages";
import { currentWorkflowPrincipal } from "./permissions";
import { resolvePublicIdParam } from "./route-params";
import { v } from "./validator";

const confirmationHash = z.string().regex(/^[a-f0-9]{64}$/);
const preview = z
  .object({
    receiptId: ShortIdSchema,
    sha256: confirmationHash,
    confirmedAt: z.iso.datetime().nullable(),
    number: z.string(),
    filename: z.string().nullable(),
    timeZone: z.string().optional(),
    warnings: z.array(z.object({ code: z.literal("pastExecutionDate"), message: z.string() }).strict()).optional(),
    version: z.literal(1),
    source: z
      .object({
        capturedAt: z.iso.datetime(),
        rowCount: z.number().int().nonnegative(),
        selectionLimit: z.number().int().positive().nullable(),
        kind: z.enum(["query", "values", "documents", "recordSnapshots", "file"]),
        query: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export const FinancialExportPreviewSchema = z.discriminatedUnion("kind", [
  preview.extend({ kind: z.literal("datev-csv"), input: DatevBatchSchema }),
  preview.extend({ kind: z.literal("sepa-xml"), input: SepaBatchSchema }),
]);
export type FinancialExportPreview = z.infer<typeof FinancialExportPreviewSchema>;

const inputFor = async (c: Context<AuthContext>) => {
  const runId = await resolvePublicIdParam(c, "runId", "workflowRun");
  const receiptId = ShortIdSchema.safeParse(c.req.param("receiptId"));
  if (!runId || !receiptId.success) return null;
  const scope = await getWorkflowRunScope(runId);
  if (!scope) return null;
  const principal = currentWorkflowPrincipal(c);
  const locale = getLocale(c);
  return {
    baseId: scope.baseId,
    runId,
    receiptId: receiptId.data,
    locale,
    actor: documentActorForScope({ principal }),
    authorize: async (tableIds: readonly string[], client: SQL) => {
      const current = await getWorkflowRunScope(runId, client);
      if (!current || current.baseId !== scope.baseId) throw err.notFound(apiMessages(c).workflowRunNotFound);
      // Re-evaluate the published action for this authenticated caller. No Base
      // admin requirement is invented for readers of a permitted Custom App.
      const caller = { ...current, principal };
      if (
        !(await canExecuteRun(caller, client)) ||
        (caller.authorization.kind === "workflow" && !(await authorizeWorkflowBase(principal, caller.baseId, "write", client)))
      )
        throw err.forbidden(documentServiceText(locale).financialAccessDenied);
      for (const tableId of tableIds)
        if (!(await canAccessWorkflowRunTable(caller, tableId, "read", client)))
          throw err.forbidden(documentServiceText(locale).financialAccessDenied);
    },
  };
};

const errors = {
  400: jsonResponse(ErrorResponseSchema, "Invalid ID or confirmation hash"),
  403: jsonResponse(ErrorResponseSchema, "Workflow or source access denied"),
  404: jsonResponse(ErrorResponseSchema, "Pending export not found"),
  409: jsonResponse(ErrorResponseSchema, "The preview or invocation is no longer valid"),
};

export const createWorkflowDocumentConfirmationRoutes = () =>
  new Hono<AuthContext>()
    .get(
      "/runs/:runId/document-confirmations/:receiptId",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Inspect the frozen normalized financial export before confirmation",
        responses: {
          200: jsonResponse(FinancialExportPreviewSchema, "Complete normalized export, bounded by the query capture budget"),
          ...errors,
        },
      }),
      async (c) => {
        const input = await inputFor(c);
        if (!input) return c.json({ message: apiMessages(c).invalidWorkflowRunId }, 400);
        c.header("Cache-Control", "private, no-store");
        return respond(c, async () => {
          const result = await documentIssuanceService.inspectQueryDocumentConfirmation(input);
          if (!result.ok) return result;
          const dateConfig = await getDateConfig(c);
          const t = documentServiceText(input.locale);
          const warnings =
            result.data.kind === "sepa-xml"
              ? sepaPreviewWarnings(result.data.input, dates.formatDateKey(new Date(), dateConfig)).map((code) => ({
                  code,
                  message: t.sepaPastExecutionDate,
                }))
              : [];
          return ok({ ...result.data, timeZone: dateConfig.timeZone, warnings });
        });
      },
    )
    .post(
      "/runs/:runId/document-confirmations/:receiptId/confirm",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Confirm this exact export preview and resume the workflow",
        responses: { 200: jsonResponse(z.object({ confirmed: z.literal(true) }).strict(), "Confirmation recorded"), ...errors },
      }),
      v("json", z.object({ sha256: confirmationHash }).strict()),
      async (c) => {
        const input = await inputFor(c);
        if (!input) return c.json({ message: apiMessages(c).invalidWorkflowRunId }, 400);
        return respond(c, async () => {
          const result = await documentIssuanceService.confirmQueryDocument({ ...input, sha256: c.req.valid("json").sha256 });
          return result.ok ? ok({ confirmed: true as const }) : fail(result.error);
        });
      },
    );
