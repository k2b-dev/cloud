import { CapabilityReviewContentSchema } from "../contracts/capabilities";

/** JSONB cannot store NUL or lone UTF-16 surrogates. Nest the content's JSON as
 * text in the existing snapshot, preserving every code unit and the public digest. */
export const serializeReviewSnapshot = (review: unknown): string => {
  if (review && typeof review === "object" && "content" in review && review.content !== undefined)
    return JSON.stringify({ ...review, content: JSON.stringify(CapabilityReviewContentSchema.parse(review.content)) });
  return JSON.stringify(review);
};

export const parseStoredReviewContent = (value: unknown) => {
  try {
    return CapabilityReviewContentSchema.safeParse(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    return CapabilityReviewContentSchema.safeParse(null);
  }
};

export const restoreReviewSnapshot = (review: unknown): unknown => {
  if (!review || typeof review !== "object" || !("content" in review)) return review;
  const content = parseStoredReviewContent(review.content);
  // Invalid stored content must fail validation, never become a content-free review.
  return { ...review, content: content.success ? content.data : null };
};
