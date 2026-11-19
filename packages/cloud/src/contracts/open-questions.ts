import { z } from "zod";
import { APPROVALS_PAGE_SIZE } from "./approvals";

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

export const AiOpenQuestionsCursorSchema = z
  .object({
    createdAt: z.iso
      .datetime({ precision: 3 })
      .describe("Last item creation time; UTC timestamp at millisecond precision from nextCursor."),
    id: z
      .string()
      .min(1)
      .max(100)
      .describe("Last item ID; unchanged from nextCursor, breaking creation-time ties; at most 100 characters."),
  })
  .strict();
export type AiOpenQuestionsCursor = z.infer<typeof AiOpenQuestionsCursorSchema>;

/** The stable oldest-first ordering shared by every source and its continuation cursor. */
export const compareAiOpenQuestions = (a: AiOpenQuestionsCursor, b: AiOpenQuestionsCursor): number => {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  // PostgreSQL COLLATE "C" orders UTF-8 IDs by code point, independent of the browser's locale.
  const left = Array.from(a.id, (character) => character.codePointAt(0)!);
  const right = Array.from(b.id, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const order = left[index]! - right[index]!;
    if (order) return order;
  }
  return left.length - right.length;
};

/** Sources retain at most one lookahead item beyond the public page size. */
export const aiOpenQuestionsPage = (items: AiOpenQuestion[], count: number, hasMore = false): AiOpenQuestions => {
  const sorted = items.sort(compareAiOpenQuestions);
  const page = sorted.slice(0, APPROVALS_PAGE_SIZE);
  const last = page.at(-1);
  return {
    count,
    items: page,
    ...(last && (hasMore || sorted.length > APPROVALS_PAGE_SIZE) ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}),
  };
};

export type AiOpenQuestions = {
  items: AiOpenQuestion[];
  /** All open questions of the person, across pages. */
  count: number;
  /** Present while another page is available; pass unchanged as `cursor`. */
  nextCursor?: AiOpenQuestionsCursor;
};

export const AiOpenQuestionsSchema = z.object({
  count: z.number().int().nonnegative(),
  nextCursor: AiOpenQuestionsCursorSchema.optional(),
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
