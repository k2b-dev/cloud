import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { toAiActionFailureResponse } from "../ai/http";
import { resolveAiChatRequestContext } from "../ai/request-context";
import { submitAiTurnAction } from "../ai/runtime";
import { aiConversations } from "../ai/store";
import {
  APPROVAL_CLIENT_HEADER,
  ApprovalCountsSchema,
  ApprovalDecisionInputSchema,
  ApprovalDecisionResultSchema,
  ApprovalListQuerySchema,
  ApprovalPageSchema,
} from "../contracts/approvals";
import { ErrorResponseSchema } from "../contracts/shared";
import { respond } from "../server/api";
import { type AuthContext, auth } from "../server/middleware/auth";
import { jsonResponse, requiresAuth } from "../server/middleware/openapi";
import { v } from "../server/middleware/validator";
import { ok } from "../server/services";
import { approvalDecisionChannel, countPending } from "../services/approvals";
import { decodeApprovalCursor } from "../services/approvals/cursor";
import { loadPendingApprovals } from "./approvals-loader";

export const approvalRoutes = new Hono<AuthContext>()
  .use(auth.requireRole("authenticated"))
  .get(
    "/",
    describeRoute({
      tags: ["Approvals"],
      summary: "List pending Action approvals",
      ...requiresAuth,
      responses: {
        200: jsonResponse(ApprovalPageSchema, "Pending approvals"),
        400: jsonResponse(ErrorResponseSchema, "Invalid query"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "User-backed actor required"),
      },
    }),
    v(
      "query",
      ApprovalListQuerySchema.refine((query) => !query.cursor || decodeApprovalCursor(query.cursor) !== null, "Invalid approval cursor."),
    ),
    async (c) => respond(c, ok(await loadPendingApprovals(c, c.req.valid("query")))),
  )
  .get(
    "/counts",
    describeRoute({
      tags: ["Approvals"],
      summary: "Count pending Action approvals",
      ...requiresAuth,
      responses: {
        200: jsonResponse(ApprovalCountsSchema, "Approval counts"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "User-backed actor required"),
      },
    }),
    async (c) => {
      const ctx = await resolveAiChatRequestContext(c);
      if (ctx instanceof Response) return ctx;
      return respond(c, ok(await countPending({ approverUserId: ctx.ownerUserId })));
    },
  )
  .post(
    "/:id/decision",
    bodyLimit({ maxSize: 1024 }),
    describeRoute({
      tags: ["Approvals"],
      summary: "Decide an Action approval and continue its chat",
      ...requiresAuth,
      responses: {
        200: jsonResponse(ApprovalDecisionResultSchema, "Approval decision"),
        400: jsonResponse(ErrorResponseSchema, "Invalid decision"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Decision refused"),
        404: jsonResponse(ErrorResponseSchema, "Open approval not found"),
        409: jsonResponse(ErrorResponseSchema, "Already decided differently"),
        413: jsonResponse(ErrorResponseSchema, "Request body too large"),
      },
    }),
    v("param", z.object({ id: z.uuid() })),
    v("json", ApprovalDecisionInputSchema),
    async (c) => {
      const ctx = await resolveAiChatRequestContext(c);
      if (ctx instanceof Response) return ctx;
      const pending = await aiConversations.findPendingTurnActionByApproval({
        approvalId: c.req.valid("param").id,
        ownerUserId: ctx.ownerUserId,
      });
      if (!pending)
        return toAiActionFailureResponse(c, {
          ok: false,
          status: 404,
          message: "This request has expired — the assistant already moved on.",
        });
      const decision = c.req.valid("json");
      const result = await submitAiTurnAction({
        conversationId: pending.conversationId,
        turnId: pending.turnId,
        callId: pending.callId,
        action: { type: "approval_response", ...decision },
        decidedBy: {
          userId: ctx.ownerUserId,
          via: approvalDecisionChannel({
            credentialKind: c.get("credentialKind"),
            actor: ctx.actor,
            client: c.req.header(APPROVAL_CLIENT_HEADER),
          }),
        },
        toolApprovalContext: ctx.toolApprovalContext,
        signedInSession: ctx.signedInSession,
      });
      if (!result.ok) return toAiActionFailureResponse(c, result);
      return respond(c, ok({ status: decision.approved ? ("approved" as const) : ("rejected" as const) }));
    },
  );
