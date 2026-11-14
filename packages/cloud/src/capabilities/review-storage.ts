import { BlockViewSchema } from "../blocks/schema";
import type { CapabilityActionCallReview } from "../contracts/capabilities";
import { LegacyCapabilityReviewContentSchema } from "./legacy-review-schema";
import { boundReviewView } from "./reviews";

/** JSON-in-text preserves NUL and lone surrogates through Postgres JSONB. Never convert before hashing. */
export const serializeReviewSnapshot = (review: unknown): string => {
  if (!review || typeof review !== "object") return JSON.stringify(review);
  const copy: Record<string, unknown> = { ...review };
  if (copy.view && "sentence" in copy)
    copy._boundViewBytes = Buffer.byteLength(JSON.stringify(boundReviewView(copy as CapabilityActionCallReview)));
  for (const key of ["content", "view"] as const)
    if (key in copy && copy[key] !== undefined) Object.assign(copy, { [key]: JSON.stringify(copy[key]) });
  return JSON.stringify(copy);
};
export const parseStoredReviewContent = (value: unknown) => {
  try {
    return LegacyCapabilityReviewContentSchema.safeParse(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    return LegacyCapabilityReviewContentSchema.safeParse(null);
  }
};
export const restoreReviewSnapshot = (review: unknown): unknown => {
  if (!review || typeof review !== "object") return review;
  const copy: Record<string, unknown> = { ...review };
  delete copy._boundViewBytes;
  for (const key of ["content", "view"] as const)
    if (key in copy) {
      let value: unknown = copy[key];
      try {
        if (typeof value === "string") value = JSON.parse(value);
      } catch {
        value = null;
      }
      const parsed = key === "view" ? BlockViewSchema.safeParse(value) : LegacyCapabilityReviewContentSchema.safeParse(value);
      Object.assign(copy, { [key]: parsed.success ? parsed.data : null });
    }
  return copy;
};
