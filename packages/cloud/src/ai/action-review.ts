import type {
  CapabilityActionCallReview,
  CapabilityActionPolicy,
  CapabilityActionReceipt,
  CapabilityActionReview,
  CapabilityActionReviewData,
  CapabilityReviewContentRef,
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
export type AiStoredActionReview = (CapabilityActionCallReview & { contentRef?: CapabilityReviewContentRef }) | AiLegacyActionReview;

export const isLegacyActionReview = (review: AiStoredActionReview): review is AiLegacyActionReview => "legacy" in review;

/** The old review shape as stored literal text. */
export const legacyActionReview = (review: CapabilityActionReview): AiLegacyActionReview => {
  const details = review.details ?? [];
  // One Markdown block, each detail under its own label, so a reader keeps knowing which text belongs where.
  const markdown = details
    .filter((detail) => detail.format === "markdown" && detail.value.trim())
    .map((detail) => `**${detail.label.replace(/([\\*_`[\]])/g, "\\$1")}**\n\n${detail.value}`)
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

/** A settled outcome survives an open response; otherwise prefer the later timestamp, or incoming without both. */
export const preferredActionCheck = (current: AiActionCheck | undefined, incoming: AiActionCheck): AiActionCheck => {
  if (!current) return incoming;
  const currentSettled = current.state === "done" || current.state === "not_done";
  const incomingSettled = incoming.state === "done" || incoming.state === "not_done";
  if (currentSettled !== incomingSettled) return currentSettled ? current : incoming;
  return current.at && incoming.at && Date.parse(current.at) > Date.parse(incoming.at) ? current : incoming;
};

/** The framework's unknown-outcome codes, in persisted `CODE: message` or structured error results. */
export const isUnknownActionOutcome = (result: unknown): boolean => {
  const code =
    typeof result === "string"
      ? /^([A-Z][A-Z0-9_]{2,}):/.exec(result.trim())?.[1]
      : result !== null && typeof result === "object" && "code" in result && typeof result.code === "string"
        ? result.code
        : undefined;
  return code === "ACTION_OUTCOME_UNKNOWN" || code === "IDEMPOTENCY_UNCERTAIN" || code === "IDEMPOTENCY_IN_PROGRESS";
};

/**
 * A `checking` claim older than this belonged to a worker or request that stopped and is open again: twice a Query's
 * 15-second budget, plus a margin. Core takes such a claim over, and the card offers to check again.
 */
export const AI_TOOL_CHECK_STALE_MS = 2 * 15_000 + 30_000;
