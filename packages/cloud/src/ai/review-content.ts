import { type SQL, sql } from "bun";
import { capabilityRequestHash } from "../capabilities/claims";
import { parseStoredReviewContent } from "../capabilities/review-storage";
import { CAPABILITY_MAX_REVIEW_CONTENT_BYTES, type CapabilityActionReviewPresentation } from "../contracts/capabilities";
import type { AiStoredActionReview } from "./action-review";

export type ReviewContentLocation = { conversationId: string; turnId: string; callId: string };

export const reviewContentHref = ({ conversationId, turnId, callId }: ReviewContentLocation): string =>
  `/api/approvals/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/reviews/${encodeURIComponent(callId)}`;

export const compactCapabilityReview = (
  review: CapabilityActionReviewPresentation,
  location: ReviewContentLocation,
): CapabilityActionReviewPresentation => {
  if (!("sentence" in review)) return review;
  const { content, ...compact } = review;
  const digest = content ? capabilityRequestHash(content) : compact.contentRef?.digest;
  return digest ? { ...compact, contentRef: { href: reviewContentHref(location), digest } } : compact;
};

/** The existing message snapshot owns both the content and its integrity reference. */
export const storedReviewWithContent = (review: AiStoredActionReview, location: ReviewContentLocation): AiStoredActionReview =>
  "content" in review && review.content
    ? { ...review, contentRef: { href: reviewContentHref(location), digest: capabilityRequestHash(review.content) } }
    : review;

/** Rebind the locator on a fork; never make the new conversation depend on access to its source. */
export const compactStoredReview = (review: AiStoredActionReview, location?: ReviewContentLocation): AiStoredActionReview => {
  if ("legacy" in review) return review;
  const { content: _content, ...compact } = review;
  return compact.contentRef && location
    ? { ...compact, contentRef: { ...compact.contentRef, href: reviewContentHref(location) } }
    : compact;
};

/** Project before transferring JSONB out of Postgres, not after loading every full review into Core. */
export const compactReviewMapSql = (reviews: SQL.Query<unknown>) => sql`(
  SELECT COALESCE(jsonb_object_agg(entry.key, entry.value - 'content'), '{}'::jsonb)
  FROM jsonb_each(CASE WHEN jsonb_typeof(${reviews}) = 'object' THEN ${reviews} ELSE '{}'::jsonb END) entry
)`;

export const compactReviewMetaSql = (meta: SQL.Query<unknown>) => sql`CASE
  WHEN ${meta} ? 'toolReviews' THEN jsonb_set(${meta}, '{toolReviews}', ${compactReviewMapSql(sql`${meta}->'toolReviews'`)})
  ELSE ${meta} END`;

/** Caller has already authorized this conversation. Read one exact persisted call from either existing message store. */
export const readReviewContent = async (location: ReviewContentLocation, digest: string, ownerUserId: string, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  const query = sql<{ content: unknown }[]>`
    SELECT meta->'toolReviews'->${location.callId}->'content' AS content
    FROM (
      SELECT meta, conversation_id, loop_id, role, seq FROM ai.messages
      UNION ALL
      SELECT meta, conversation_id, loop_id, role, seq FROM ai.task_messages
    ) messages
    WHERE conversation_id=${location.conversationId}::uuid AND loop_id=${location.turnId} AND role='assistant'
      AND EXISTS (SELECT 1 FROM ai.conversations c WHERE c.id=messages.conversation_id
        AND c.created_by_user_id=${ownerUserId}::uuid AND c.archived_at IS NULL)
      AND meta->'toolReviews'->${location.callId}->'contentRef'->>'digest'=${digest}
      AND octet_length((meta->'toolReviews'->${location.callId}->'content')::text) <= ${2 * CAPABILITY_MAX_REVIEW_CONTENT_BYTES + 2}
    ORDER BY seq DESC LIMIT 1`;
  // JSONB adds spaces after punctuation; at most twice the compact JSON budget. The exact limit is checked below.
  const abort = () => query.cancel();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let rows: { content: unknown }[];
  try {
    rows = await query;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  signal?.throwIfAborted();
  const row = rows[0];
  const parsed = parseStoredReviewContent(row?.content);
  return parsed.success && capabilityRequestHash(parsed.data) === digest ? parsed.data : null;
};
