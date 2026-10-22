import { sql } from "bun";
import { z } from "zod";
import { APPROVALS_PAGE_SIZE } from "../contracts/approvals";
import { CapabilityActionReviewPresentationSchema, CapabilitySemanticLinkSchema } from "../contracts/capabilities";
import { openRequests } from "../services/approvals/content";
import { logger } from "../services/logging";
import { reviewShortText, toolActionCard, toolBlockReview } from "./chat/action-card";
import { aiToolIcon } from "./chat/message-utils";
import { legacyOutcomeWords } from "./chat/tool-action-words";
import { type AiTurnBlock, toolBlockId } from "./protocol";

export type AiOpenQuestion = {
  /** The approval request id (approvals.requests.id). */
  id: string;
  /** Short id of the chat the question waits in. */
  conversationId: string;
  /** The chat's current title, at most 200 code points; chat content, never Cloud's words. */
  conversationTitle: string | null;
  /** The question's data-chat-anchor: the id of the tool block the chat renders it in. */
  anchor: string;
  /** The question's short form, plain text, at most 160 code points. */
  short: string;
  /** The app the question is about, as the card shows it. */
  app: { name: string; icon: string; accent?: string };
  createdAt: string;
};

export type AiOpenQuestions = {
  items: AiOpenQuestion[];
  /** All open questions of the person, across pages. */
  count: number;
};

type QuestionRow = {
  id: string;
  conversationId: string;
  conversationTitle: string | null;
  displayCallId: string;
  appId: string;
  sentence: string;
  toolName: string;
  createdAt: Date;
  block: Extract<AiTurnBlock, { kind: "tool" }> | null;
};

const log = logger("ai:open-questions");
const legacyReviewSchema = z.object({
  question: z.string().min(1),
  rows: z.array(z.object({ label: z.string(), value: z.string(), format: z.enum(["date", "date-time"]).optional() })),
  markdown: z.string().optional(),
  summary: z.string().optional(),
  links: z.array(CapabilitySemanticLinkSchema).optional(),
});

const ownedRequests = (ownerUserId: string) => sql`
  SELECT r.* FROM (${openRequests(ownerUserId)}) r
  WHERE EXISTS (
    SELECT 1 FROM ai.pending_actions p JOIN ai.conversations c ON c.id=p.conversation_id
    WHERE p.approval_id=r.id AND p.status='pending' AND p.kind IN ('approval','custom_approval')
      AND c.created_by_user_id=${ownerUserId}::uuid
  )`;

/** One bounded, owner-scoped snapshot, using exactly the chat's stored question card. */
export const listAiOpenQuestions = async (input: { ownerUserId: string; locale: string; timeZone: string }): Promise<AiOpenQuestions> => {
  const [counts] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM (${ownedRequests(input.ownerUserId)}) r`;
  const rows = await sql<QuestionRow[]>`
    WITH page AS (
      SELECT * FROM (${ownedRequests(input.ownerUserId)}) r
      ORDER BY r.created_at DESC, r.id DESC LIMIT ${APPROVALS_PAGE_SIZE}
    )
    SELECT r.id, r.app_id AS "appId", r.sentence, r.created_at AS "createdAt",
      question.short_id AS "conversationId", question.title AS "conversationTitle",
      question.display_call_id AS "displayCallId", question.tool_name AS "toolName", question.block
    FROM page r JOIN LATERAL (
      SELECT c.short_id, c.title, p.tool_name,
        CASE WHEN p.kind='custom_approval'
          THEN COALESCE(substring(p.call_id FROM '^(.*)-approval-[0-9]+$'), p.call_id)
          ELSE p.call_id END AS display_call_id,
        (SELECT block FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(t.live_blocks)='array' THEN t.live_blocks ELSE '[]'::jsonb END
        ) AS blocks(block)
          WHERE block->>'kind'='tool' AND block->>'callId'=p.call_id LIMIT 1) AS block
      FROM ai.pending_actions p JOIN ai.conversations c ON c.id=p.conversation_id
        JOIN ai.turns t ON t.id=p.turn_id
      WHERE p.approval_id=r.id AND p.status='pending' AND p.kind IN ('approval','custom_approval')
        AND c.created_by_user_id=${input.ownerUserId}::uuid
      ORDER BY p.created_at DESC, p.id DESC LIMIT 1
    ) question ON true
    ORDER BY r.created_at DESC, r.id DESC`;

  return {
    count: counts?.count ?? 0,
    items: rows.map((row) => openQuestionFromRow(row, input)),
  };
};

/** Stop at the payload bound without splitting a Unicode code point or copying the rest of a legacy message. */
const boundedText = (text: string, max: number): string => {
  const points: string[] = [];
  for (const point of text) {
    if (points.length === max) return `${points.slice(0, max - 1).join("")}…`;
    points.push(point);
  }
  return text;
};

/** Present one stored question without database access. */
export const openQuestionFromRow = (row: QuestionRow, input: { locale: string; timeZone: string }): AiOpenQuestion => {
  const block = row.block;
  const presentation = block?.presentation;
  const question: AiOpenQuestion = {
    id: row.id,
    conversationId: row.conversationId,
    conversationTitle: row.conversationTitle === null ? null : boundedText(row.conversationTitle, 200),
    // The id the chat renders the card under: a custom approval's card carries its parent call, also when a stored
    // block still has the approval's own id (see normalizeCustomApprovalBlocks in client/projection.ts).
    anchor: toolBlockId(row.displayCallId),
    short: boundedText(row.sentence.split(/\r?\n/, 1)[0] ?? "", 160),
    app: {
      name: typeof presentation?.appName === "string" ? presentation.appName : block ? "Cloud" : row.appId,
      icon: aiToolIcon(
        typeof block?.name === "string" ? block.name : row.toolName,
        typeof presentation?.appIcon === "string" ? presentation.appIcon : undefined,
      ),
      ...(typeof presentation?.appAccent === "string" ? { accent: presentation.appAccent } : {}),
    },
    createdAt: row.createdAt.toISOString(),
  };
  if (!block) return question;
  try {
    if (
      typeof block.id !== "string" ||
      !block.id ||
      typeof block.name !== "string" ||
      !block.name ||
      typeof block.callId !== "string" ||
      !["running", "awaiting_approval", "awaiting_client", "completed", "failed", "rejected"].includes(block.status)
    )
      throw new Error("Malformed tool block");
    if (block.review == null && block.approval?.review != null) CapabilityActionReviewPresentationSchema.parse(block.approval.review);
    const review = toolBlockReview(block);
    if (review !== null) {
      if ("legacy" in review) legacyReviewSchema.parse(review.legacy);
      else CapabilityActionReviewPresentationSchema.parse(review);
    }
    const card = toolActionCard(block, {
      locale: input.locale,
      timeZone: input.timeZone,
      outcome: legacyOutcomeWords(block, input.locale, input.timeZone),
    });
    const short =
      review && !("legacy" in review)
        ? reviewShortText(review, { locale: input.locale, timeZone: input.timeZone, app: card.app })
        : card.questionText;
    if (
      typeof short !== "string" ||
      typeof card.app.name !== "string" ||
      typeof card.app.icon !== "string" ||
      (card.app.accent !== undefined && typeof card.app.accent !== "string")
    )
      throw new Error("Malformed question card");
    return { ...question, short: boundedText(short, 160), app: card.app };
  } catch {
    log.warn("Failed to present open question", { approvalId: row.id, conversationId: row.conversationId });
    return question;
  }
};
