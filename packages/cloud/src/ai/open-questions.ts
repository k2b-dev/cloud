import { z } from "zod";
import { type CapabilityCaller, invokeCapabilityWithDataSchema } from "../capabilities/server";
import { APPROVALS_PAGE_SIZE } from "../contracts/approvals";
import { CapabilityActionReviewPresentationSchema, CapabilitySemanticLinkSchema } from "../contracts/capabilities";
import { sql } from "../runtime/clients";
import type { RequestAuthority } from "../server";
import { openRequests } from "../services/approvals/content";
import { logger } from "../services/logging";
import { reviewShortText, toolActionCard, toolBlockReview } from "./chat/action-card";
import { aiToolIcon } from "./chat/message-utils";
import { legacyOutcomeWords } from "./chat/tool-action-words";
import { type AiTurnBlock, toolBlockId } from "./protocol";

/**
 * What waits for the person, by kind: each kind has its sign in "Waiting for you" and its own way to the thing. Cloud
 * lists approvals; Code adds its entries with kinds of its own (Bauplan 3m).
 */
export const AI_OPEN_QUESTION_KINDS = ["approval", "code_activate", "code_changes", "code_expired", "code_attention"] as const;
export type AiOpenQuestionKind = (typeof AI_OPEN_QUESTION_KINDS)[number];

export type AiOpenQuestion = {
  kind: AiOpenQuestionKind;
  /** An entry without a chat opens its authorized source page. */
  href?: string;
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
  /** Why the person's own Code waits (`code_attention` only); "Waiting for you" names the way out by it. */
  reason?: AiOpenQuestionCodeReason;
  /** The archived chat personal Code still writes to (`chat_missing` only); its owner can restore it in place. */
  archivedChat?: { id: string; title: string };
  createdAt: string;
};

export const AI_OPEN_QUESTION_CODE_REASONS = ["chat_missing", "secret", "mandate", "access"] as const;
export type AiOpenQuestionCodeReason = (typeof AI_OPEN_QUESTION_CODE_REASONS)[number];

export type AiOpenQuestions = {
  items: AiOpenQuestion[];
  /** All open questions of the person, across pages. */
  count: number;
};

export const AiOpenQuestionsSchema = z.object({
  count: z.number().int().nonnegative(),
  items: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(AI_OPEN_QUESTION_KINDS),
        href: z.string().startsWith("/").optional(),
        conversationId: z.string(),
        conversationTitle: z.string().nullable(),
        anchor: z.string(),
        short: z.string(),
        app: z.object({ name: z.string(), icon: z.string(), accent: z.string().optional() }),
        reason: z.enum(AI_OPEN_QUESTION_CODE_REASONS).optional(),
        archivedChat: z.object({ id: z.string(), title: z.string() }).optional(),
        createdAt: z.iso.datetime(),
      }),
    )
    .max(APPROVALS_PAGE_SIZE),
});
/** A source answers for one `kind` alone when the reader asks for it, with the same page size. */
export type AiOpenQuestionSource = (input: {
  ownerUserId: string;
  locale: string;
  timeZone: string;
  kind?: AiOpenQuestionKind;
}) => Promise<AiOpenQuestions>;

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

/** How many questions wait for their owner's answer, such as a badge on the Assistant; the same rows as the list. */
const countApprovalQuestions = async (ownerUserId: string): Promise<number> => {
  const [counts] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM (${ownedRequests(ownerUserId)}) r`;
  return counts?.count ?? 0;
};

/** One bounded, owner-scoped snapshot, using exactly the chat's stored question card. */
export const countAiOpenQuestions = async (
  ownerUserId: string,
  options?: { authority?: RequestAuthority; caller?: CapabilityCaller },
): Promise<number> =>
  options?.authority || options?.caller
    ? (await listAiOpenQuestions({ ownerUserId, locale: "en", timeZone: "UTC", ...options })).count
    : countApprovalQuestions(ownerUserId);

export const listAiOpenQuestions = async (input: {
  ownerUserId: string;
  locale: string;
  timeZone: string;
  authority?: RequestAuthority;
  /** An app outside Core forwards the person's own credentials; `authority` dispatches in the Core process only. */
  caller?: CapabilityCaller;
  sources?: readonly AiOpenQuestionSource[];
  /** Only this kind, in the same page size: a page section that lists one kind never loses it behind older questions. */
  kind?: AiOpenQuestionKind;
}): Promise<AiOpenQuestions> => {
  const caller = input.caller ?? (input.authority ? { authority: input.authority, locale: input.locale } : undefined);
  if (caller) {
    const authority = caller.authority;
    if (authority && (authority.accessSubject.type !== "user" || authority.accessSubject.userId !== input.ownerUserId))
      throw new Error("Question owner and authority disagree");
    const result = await invokeCapabilityWithDataSchema(
      {
        appId: "core",
        capabilityId: "ai.open_questions",
        kind: "query",
        input: { timeZone: input.timeZone, ...(input.kind ? { kind: input.kind } : {}) },
      },
      AiOpenQuestionsSchema,
      caller,
    );
    if (!result.ok) throw new Error(`Open questions unavailable: ${result.error.code}`);
    return result.data.data;
  }
  const approvals = !input.kind || input.kind === "approval";
  const count = approvals ? await countApprovalQuestions(input.ownerUserId) : 0;
  const rows = !approvals
    ? []
    : await sql<QuestionRow[]>`
    WITH page AS (
      SELECT * FROM (${ownedRequests(input.ownerUserId)}) r
      ORDER BY r.created_at ASC, r.id ASC LIMIT ${APPROVALS_PAGE_SIZE}
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
    ORDER BY r.created_at ASC, r.id ASC`;

  const sources = await Promise.all((input.sources ?? []).map((source) => source(input)));
  return {
    count: count + sources.reduce((sum, source) => sum + source.count, 0),
    items: [...rows.map((row) => openQuestionFromRow(row, input)), ...sources.flatMap((source) => source.items)]
      .filter((item) => !input.kind || item.kind === input.kind)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, APPROVALS_PAGE_SIZE),
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
    kind: "approval",
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
