import { z } from "zod";
import { type CapabilityCaller, invokeCapabilityWithDataSchema } from "../capabilities/server";
import { APPROVALS_PAGE_SIZE } from "../contracts/approvals";
import { CapabilityActionReviewPresentationSchema, CapabilitySemanticLinkSchema } from "../contracts/capabilities";
import {
  type AiOpenQuestion,
  type AiOpenQuestionKind,
  type AiOpenQuestions,
  type AiOpenQuestionsCursor,
  AiOpenQuestionsCursorSchema,
  AiOpenQuestionsSchema,
  aiOpenQuestionsPage,
  compareAiOpenQuestions,
} from "../contracts/open-questions";
import { sql } from "../runtime/clients";
import type { RequestAuthority } from "../server";
import { openRequests } from "../services/approvals/content";
import { logger } from "../services/logging";
import { reviewShortText, toolActionCard, toolBlockReview } from "./chat/action-card";
import { aiToolIcon } from "./chat/message-utils";
import { legacyOutcomeWords } from "./chat/tool-action-words";
import { type AiTurnBlock, toolBlockId } from "./protocol";

export {
  AI_OPEN_QUESTION_CODE_REASONS,
  AI_OPEN_QUESTION_KINDS,
  type AiOpenQuestion,
  type AiOpenQuestionCodeReason,
  type AiOpenQuestionKind,
  type AiOpenQuestions,
  type AiOpenQuestionsCursor,
  AiOpenQuestionsCursorSchema,
  AiOpenQuestionsSchema,
  aiOpenQuestionsPage,
  compareAiOpenQuestions,
} from "../contracts/open-questions";

/** Sources count every matching question, but return only one page after `cursor`, with a continuation if needed. */
export type AiOpenQuestionSource = (input: {
  ownerUserId: string;
  locale: string;
  timeZone: string;
  kind?: AiOpenQuestionKind;
  cursor?: AiOpenQuestionsCursor;
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

const ownedSecretQuestions = (ownerUserId: string) => sql`
  SELECT p.id, p.created_at, p.call_id, p.args->>'name' AS name, c.short_id, c.title
  FROM ai.pending_actions p JOIN ai.conversations c ON c.id=p.conversation_id
    JOIN ai.turns t ON t.id=p.turn_id
  WHERE c.created_by_user_id=${ownerUserId}::uuid AND c.archived_at IS NULL
    AND p.kind='client_tool' AND p.tool_name='code_secret' AND p.status='pending'
    AND t.status='waiting_for_action'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.live_blocks)='array' THEN t.live_blocks ELSE '[]'::jsonb END) b
      WHERE b->>'kind'='tool' AND b->>'name'='code_secret' AND b->>'callId'=p.call_id AND b->>'status'='awaiting_client')`;
const countSecretQuestions = async (ownerUserId: string): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM (${ownedSecretQuestions(ownerUserId)}) q`;
  return row?.count ?? 0;
};
/** Metadata-only projection: never copy tool args/results into the waiting list. */
export const secretOpenQuestion = (row: {
  id: string;
  created_at: Date;
  call_id: string;
  name: string;
  short_id: string;
  title: string | null;
}): AiOpenQuestion => ({
  id: row.id,
  kind: "secret",
  conversationId: row.short_id,
  conversationTitle: row.title === null ? null : boundedText(row.title, 200),
  anchor: toolBlockId(row.call_id),
  short: `Secret ${/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(row.name) ? row.name : ""}`.trim(),
  app: { name: "Gustav", icon: "ti ti-key" },
  createdAt: row.created_at.toISOString(),
});
const listSecretQuestions = async (input: { ownerUserId: string; cursor?: AiOpenQuestionsCursor }): Promise<AiOpenQuestions> => {
  const count = await countSecretQuestions(input.ownerUserId);
  const rows = await sql<Parameters<typeof secretOpenQuestion>[0][]>`
    SELECT * FROM (${ownedSecretQuestions(input.ownerUserId)}) q
    WHERE ${input.cursor ? sql`(date_trunc('milliseconds',q.created_at),q.id::text COLLATE "C") > (${input.cursor.createdAt}::timestamptz,${input.cursor.id}::text COLLATE "C")` : sql`TRUE`}
    ORDER BY date_trunc('milliseconds',q.created_at),q.id LIMIT ${APPROVALS_PAGE_SIZE + 1}`;
  return aiOpenQuestionsPage(rows.map(secretOpenQuestion), count);
};

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
    : (await countApprovalQuestions(ownerUserId)) + (await countSecretQuestions(ownerUserId));

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
  cursor?: AiOpenQuestionsCursor;
}): Promise<AiOpenQuestions> => {
  if (input.cursor) AiOpenQuestionsCursorSchema.parse(input.cursor);
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
        input: { timeZone: input.timeZone, ...(input.kind ? { kind: input.kind } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) },
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
      WHERE ${input.cursor ? sql`(date_trunc('milliseconds', r.created_at), r.id::text COLLATE "C") > (${input.cursor.createdAt}::timestamptz, ${input.cursor.id}::text COLLATE "C")` : sql`TRUE`}
      ORDER BY date_trunc('milliseconds', r.created_at) ASC, r.id ASC LIMIT ${APPROVALS_PAGE_SIZE + 1}
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
    ORDER BY date_trunc('milliseconds', r.created_at) ASC, r.id ASC`;

  const sources = await Promise.all([
    ...(input.sources ?? []).map((source) => source(input)),
    ...(!input.kind || input.kind === "secret" ? [listSecretQuestions(input)] : []),
  ]);
  return aiOpenQuestionsPage(
    [...rows.map((row) => openQuestionFromRow(row, input)), ...sources.flatMap((source) => source.items)].filter(
      (item) => (!input.kind || item.kind === input.kind) && (!input.cursor || compareAiOpenQuestions(item, input.cursor) > 0),
    ),
    count + sources.reduce((sum, source) => sum + source.count, 0),
    sources.some((source) => source.nextCursor !== undefined),
  );
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
