import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { toAiActionFailureResponse } from "../ai/http";
import { resolveAiChatRequestContext } from "../ai/request-context";
import { readReviewContent } from "../ai/review-content";
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
import { CapabilityReviewContentSchema } from "../contracts/capabilities";
import { ErrorResponseSchema } from "../contracts/shared";
import { rateLimit } from "../server";
import { userFromActor } from "../server/actor";
import { respond } from "../server/api";
import { type AuthContext, auth } from "../server/middleware/auth";
import { noTransform } from "../server/middleware/no-transform";
import { jsonResponse, requiresAuth } from "../server/middleware/openapi";
import { v } from "../server/middleware/validator";
import { ok } from "../server/services";
import { ApprovalDecisionConflictError, approvalDecisionChannel, approvals, countPending } from "../services/approvals";
import { readApprovalContent } from "../services/approvals/content";
import { decodeApprovalCursor } from "../services/approvals/cursor";
import { loadPendingApprovals } from "./approvals-loader";

export const approvalRoutes = new Hono<AuthContext>()
  .use("*", noTransform())
  .use(rateLimit())
  .use(auth.requireRole("authenticated"))
  .get(
    "/:id/content",
    describeRoute({
      tags: ["Approvals"],
      summary: "Read one complete pending approval snapshot",
      ...requiresAuth,
      responses: {
        200: jsonResponse(CapabilityReviewContentSchema, "Complete reviewed content"),
        404: jsonResponse(ErrorResponseSchema, "Snapshot unavailable"),
      },
    }),
    v("param", z.object({ id: z.uuid() })),
    v("query", z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
    async (c) => {
      const user = userFromActor(c.get("actor"));
      if (!user) return c.json({ message: "Approvals require a user-backed actor." }, 403);
      const content = await readApprovalContent({
        ...c.req.valid("param"),
        ...c.req.valid("query"),
        approverUserId: user.id,
        roleContext: { kind: "request", authority: auth.getAuthority(c) },
        signal: c.req.raw.signal,
      });
      c.header("Cache-Control", "private, no-store");
      return content ? c.json(content) : c.json({ message: "This review is no longer available." }, 404);
    },
  )
  .get(
    "/conversations/:conversationId/turns/:turnId/reviews/:callId",
    describeRoute({
      tags: ["Approvals"],
      summary: "Read one historical conversation review snapshot",
      ...requiresAuth,
      responses: {
        200: jsonResponse(CapabilityReviewContentSchema, "Complete reviewed content"),
        404: jsonResponse(ErrorResponseSchema, "Snapshot unavailable"),
      },
    }),
    v("param", z.object({ conversationId: z.uuid(), turnId: z.uuid(), callId: z.string().min(1).max(200) })),
    v("query", z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
    async (c) => {
      const ctx = await resolveAiChatRequestContext(c);
      if (ctx instanceof Response) return ctx;
      const location = c.req.valid("param");
      c.header("Cache-Control", "private, no-store");
      const content = await readReviewContent(location, c.req.valid("query").digest, ctx.ownerUserId, c.req.raw.signal);
      return content ? c.json(content) : c.json({ message: "This review is no longer available." }, 404);
    },
  )
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
      const user = userFromActor(c.get("actor"));
      if (!user) return c.json({ message: "Approvals require a user-backed actor." }, 403);
      return respond(
        c,
        ok(await countPending({ approverUserId: user.id, roleContext: { kind: "request", authority: auth.getAuthority(c) } })),
      );
    },
  )
  .post(
    "/:id/decision",
    bodyLimit({ maxSize: 1024 }),
    describeRoute({
      tags: ["Approvals"],
      summary: "Decide an approval; continue its chat when one waits",
      ...requiresAuth,
      responses: {
        200: jsonResponse(ApprovalDecisionResultSchema, "Approval decision"),
        400: jsonResponse(ErrorResponseSchema, "Invalid decision"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Decision refused"),
        404: jsonResponse(ErrorResponseSchema, "Open approval not found"),
        409: jsonResponse(ErrorResponseSchema, "Already decided differently"),
        413: jsonResponse(ErrorResponseSchema, "Request body too large"),
        503: jsonResponse(ErrorResponseSchema, "Version decision service unavailable or admin population busy"),
      },
    }),
    v("param", z.object({ id: z.uuid() })),
    v("json", ApprovalDecisionInputSchema),
    async (c) => {
      const user = userFromActor(c.get("actor"));
      if (!user) return c.json({ message: "Approvals require a user-backed actor." }, 403);
      const record = await approvals.get(c.req.valid("param").id, undefined, true);
      if (record?.kind === "code_version") {
        const decision = c.req.valid("json");
        const result = await approvals
          .decide(record.id, decision, {
            userId: user.id,
            authority: auth.getAuthority(c),
            via: approvalDecisionChannel({
              credentialKind: c.get("credentialKind"),
              actor: c.get("actor"),
              client: c.req.header(APPROVAL_CLIENT_HEADER),
            }),
          })
          .catch((error: unknown) => {
            if (error instanceof ApprovalDecisionConflictError) return error;
            throw error;
          });
        if (result instanceof ApprovalDecisionConflictError) return c.json({ code: result.code, message: result.message }, 409);
        if (result.ok) return respond(c, ok({ status: decision.approved ? ("approved" as const) : ("rejected" as const) }));
        if (result.code === "BUSY")
          return c.json({ code: "BUSY", message: "The admin population is changing or another review is in progress. Try again." }, 503);
        if (result.code === "REAUTHENTICATE")
          return c.json(
            { code: "REAUTHENTICATE", message: "Confirm self-approval after a recent full browser sign-in, or use Cloud Login." },
            403,
          );
        if (result.code === "NOT_REMEMBERABLE") return c.json({ message: "Code-version approvals cannot be remembered." }, 400);
        if (result.code === "NOT_FOUND") return c.json({ message: "Open approval not found." }, 404);
        if (result.code === "SELF_APPROVAL" || result.code === "REJECT_ONLY")
          return c.json(
            {
              code: result.code,
              message:
                result.code === "SELF_APPROVAL" ? "Another Cloud admin must approve this version." : "Approve this request in Cloud.",
            },
            403,
          );
        if (result.code === "UNAVAILABLE")
          return c.json({ message: "Version decisions are temporarily unavailable. Try again later." }, 503);
        return c.json({ message: "This request has expired or was already decided." }, 409);
      }
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
        toolApprovalContext: ctx.toolApprovalChangeContext,
        signedInSession: ctx.signedInSession,
      });
      if (!result.ok) return toAiActionFailureResponse(c, result);
      return respond(c, ok({ status: decision.approved ? ("approved" as const) : ("rejected" as const) }));
    },
  );
