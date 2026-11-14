import type { SQL } from "bun";
import { capabilityRequestHash } from "../capabilities/claims";
import { presentReview } from "../capabilities/legacy-review-view";
import { restoreReviewSnapshot } from "../capabilities/review-storage";
import { boundReviewView, reviewDraft } from "../capabilities/reviews";
import { CAPABILITY_MAX_REVIEW_CONTENT_BYTES, type CapabilityActionReviewPresentation } from "../contracts/capabilities";
import { CAPABILITY_MAX_REVIEW_BYTES } from "../contracts/capability-limits";
import { sql } from "../runtime/clients";
import type { AiStoredActionReview } from "./action-review";

export type ReviewContentLocation = { conversationId: string; turnId: string; callId: string };

export const reviewContentHref = ({ conversationId, turnId, callId }: ReviewContentLocation): string =>
  `/api/approvals/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/reviews/${encodeURIComponent(callId)}`;

export const compactCapabilityReview = (
  review: CapabilityActionReviewPresentation,
  location: ReviewContentLocation,
): CapabilityActionReviewPresentation => {
  if (!("sentence" in review)) return review;
  const raw = restoreReviewSnapshot(review);
  const legacy =
    !!raw &&
    typeof raw === "object" &&
    ((!("view" in raw) && ("preview" in raw || "content" in raw)) || ("draft" in raw && review.draft?.editable === false));
  const presentation = presentReview(raw) as typeof review;
  const { editedFields: _edited, ...clean } = presentation as typeof presentation & { editedFields?: string[] };
  const { view, contentRef, ...compact } = clean;
  if (view && new TextEncoder().encode(JSON.stringify(view)).byteLength <= CAPABILITY_MAX_REVIEW_BYTES)
    return { ...compact, view, ...(legacy && contentRef ? { contentRef: { ...contentRef, href: reviewContentHref(location) } } : {}) };
  const digest = contentRef?.digest ?? (view ? capabilityRequestHash(view) : undefined);
  return digest ? { ...compact, contentRef: { href: reviewContentHref(location), digest } } : compact;
};

/** The existing message snapshot owns both the content and its integrity reference. */
export const storedReviewWithContent = (review: AiStoredActionReview, location: ReviewContentLocation): AiStoredActionReview => {
  if ("legacy" in review) return review;
  const view = boundReviewView(review);
  const draft = reviewDraft(view?.blocks);
  return view
    ? {
        ...review,
        ...(draft ? { draft: review.draft ?? { editable: true, fields: draft.fields.map((field) => field.name) } } : {}),
        contentRef: { href: reviewContentHref(location), digest: capabilityRequestHash(view) },
      }
    : review;
};

export const compactStoredReview = (review: AiStoredActionReview, location?: ReviewContentLocation): AiStoredActionReview => {
  if ("legacy" in review) return review;
  const href = review.contentRef?.href;
  const fallback = location ?? (href ? parseReviewLocation(href) : undefined);
  if (fallback) return compactCapabilityReview(review, fallback) as AiStoredActionReview;
  return presentReview(restoreReviewSnapshot(review)) as AiStoredActionReview;
};
const parseReviewLocation = (href: string): ReviewContentLocation | undefined => {
  const m = /^\/api\/approvals\/conversations\/([^/]+)\/turns\/([^/]+)\/reviews\/(.+)$/.exec(href);
  return m ? { conversationId: m[1]!, turnId: m[2]!, callId: decodeURIComponent(m[3]!) } : undefined;
};

/** Strip large snapshots in SQL, retaining small raw views for binding at the read boundary. */
export const compactReviewSql = (review: SQL.Query<unknown>) => sql`(${review} - 'content' - 'view' - '_boundViewBytes') || CASE
  WHEN ${review} ? 'view' AND (octet_length(${review}->>'view') <= ${CAPABILITY_MAX_REVIEW_BYTES} OR (${review}->>'_boundViewBytes')::integer <= ${CAPABILITY_MAX_REVIEW_BYTES})
  THEN jsonb_build_object('view',${review}->'view') ELSE '{}'::jsonb END`;

/** Project before transferring JSONB out of Postgres, not after loading every full review into Core. */
export const compactReviewMapSql = (reviews: SQL.Query<unknown>) => sql`(
  SELECT COALESCE(jsonb_object_agg(entry.key, ${compactReviewSql(sql`entry.value`)}), '{}'::jsonb)
  FROM jsonb_each(CASE WHEN jsonb_typeof(${reviews}) = 'object' THEN ${reviews} ELSE '{}'::jsonb END) entry
)`;

export const compactReviewMetaSql = (meta: SQL.Query<unknown>) => sql`CASE
  WHEN ${meta} ? 'toolReviews' THEN jsonb_set(${meta}, '{toolReviews}', ${compactReviewMapSql(sql`${meta}->'toolReviews'`)})
  ELSE ${meta} END`;

/** Caller has already authorized this conversation. Read one exact persisted call from either existing message store. */
export const readReviewContent = async (location: ReviewContentLocation, digest: string, ownerUserId: string, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  const query = sql<{ content: unknown }[]>`
    SELECT meta->'toolReviews'->${location.callId} AS content
    FROM (
      SELECT meta, conversation_id, loop_id, role, seq FROM ai.messages
      UNION ALL
      SELECT meta, conversation_id, loop_id, role, seq FROM ai.task_messages
    ) messages
    WHERE conversation_id=${location.conversationId}::uuid AND loop_id=${location.turnId} AND role='assistant'
      AND EXISTS (SELECT 1 FROM ai.conversations c WHERE c.id=messages.conversation_id
        AND c.created_by_user_id=${ownerUserId}::uuid AND c.archived_at IS NULL)
      AND meta->'toolReviews'->${location.callId}->'contentRef'->>'digest'=${digest}
      AND octet_length((meta->'toolReviews'->${location.callId})::text) <= ${2 * CAPABILITY_MAX_REVIEW_CONTENT_BYTES + 65536}
    ORDER BY seq DESC LIMIT 1`;
  // JSONB adds spaces after punctuation; at most twice the compact JSON budget. The exact limit is checked below.
  const abort = () => void query.cancel().catch(() => {});
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
  const raw = restoreReviewSnapshot(row?.content);
  if (!raw || typeof raw !== "object") return null;
  const payload =
    "view" in raw
      ? boundReviewView(raw as Extract<CapabilityActionReviewPresentation, { sentence: unknown }>)
      : "content" in raw
        ? raw.content
        : undefined;
  if (!payload || capabilityRequestHash(payload) !== digest) return null;
  const review = presentReview(raw);
  return review && typeof review === "object" && "view" in review ? review.view : null;
};
