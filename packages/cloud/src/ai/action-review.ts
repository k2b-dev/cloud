import type {
  CapabilityActionCallReview,
  CapabilityActionPolicy,
  CapabilityActionReceipt,
  CapabilityActionReview,
  CapabilityActionReviewData,
  CapabilitySemanticLink,
} from "../contracts/capabilities";

/**
 * What the chat stores about one Action call so that a reload shows the same question and receipt even after the app
 * changed: the app's per-call review as it was when Cloud asked, or, for an app that still returns the old review shape,
 * that review as literal text. Pure and browser-safe: the server stores it, the chat renders it.
 */

/** One old review detail: a label and its value, kept complete. */
export type AiLegacyReviewRow = { label: string; value: string; format?: "date" | "date-time" };

/**
 * An old review (`message`, `details`, `links`) kept as literal text, never as a template: the message is the question,
 * every inline or plain-text detail is a row without the 12-row bound, Markdown details are one Markdown block, and
 * `summary` is the old success summary used as the receipt text.
 */
export type AiLegacyActionReview = {
  legacy: {
    question: string;
    rows: AiLegacyReviewRow[];
    markdown?: string;
    summary?: string;
    links?: CapabilitySemanticLink[];
  };
};

/** A new review, with `ask` filled from the declared policy when the call itself names no reason. */
export type AiStoredActionReview = CapabilityActionCallReview | AiLegacyActionReview;

export const isLegacyActionReview = (review: AiStoredActionReview): review is AiLegacyActionReview => "legacy" in review;

/** The old review shape as stored literal text. */
export const legacyActionReview = (review: CapabilityActionReview): AiLegacyActionReview => {
  const details = review.details ?? [];
  const markdown = details
    .filter((detail) => detail.format === "markdown")
    .map((detail) => detail.value)
    .filter((value) => value.trim())
    .join("\n\n");
  return {
    legacy: {
      question: review.message,
      rows: details
        .filter((detail) => detail.format !== "markdown")
        .map((detail) => ({
          label: detail.label,
          value: detail.value,
          ...(detail.format === "date" || detail.format === "date-time" ? { format: detail.format } : {}),
        })),
      ...(markdown ? { markdown } : {}),
      ...(review.links?.length ? { links: review.links } : {}),
    },
  };
};

/** The review Cloud stores and shows for one call. */
export const storedActionReview = (review: CapabilityActionReviewData, policy?: CapabilityActionPolicy | null): AiStoredActionReview => {
  if (!("sentence" in review)) return legacyActionReview(review);
  if (review.ask || !policy || !("ask" in policy)) return review;
  return { ...review, ask: policy.ask };
};

/**
 * The app's `check` Query after an outcome Cloud could not see. `checking` while it runs; `done` and `not_done` settle
 * the call; `pending` means the app does not know yet; `failed` means the check itself gave no usable answer.
 */
export type AiActionCheckState = "checking" | "done" | "not_done" | "pending" | "failed";
export type AiActionCheck = { state: AiActionCheckState; receipt?: CapabilityActionReceipt; at?: string };
