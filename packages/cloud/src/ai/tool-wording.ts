import {
  type CapabilityActionWording,
  capabilityActionOutcome,
  capabilityActionSubject,
  capabilityReviewSentence,
  capabilitySentenceText,
} from "../_internal/capability-sentences";
import { CapabilityActionReceiptSchema } from "../contracts/capabilities";
import { type AiStoredActionReview, isLegacyActionReview, storedActionReview } from "./action-review";
import { isRecord } from "./chat/message-utils";
import type { AiTurnBlock } from "./protocol";
import { cloudToolReview } from "./tool-sentences";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

/** The review Cloud stored for the call, else the one its open approval carries. */
const reviewOf = (block: ToolBlock): AiStoredActionReview | null =>
  block.review ?? (block.approval?.review ? storedActionReview(block.approval.review) : null);

/**
 * How the chat words one call that acts on something: an app Action through its saved presentation, a
 * Cloud tool through its per-call review. `null` for calls that only read.
 */
export const toolWording = (block: ToolBlock, locale: string): CapabilityActionWording | null => {
  const presentation = block.presentation;
  if (presentation?.kind === "capability") {
    if (presentation.capabilityKind !== "action") return null;
    return {
      title: presentation.title,
      ...(presentation.sentences ? { sentences: presentation.sentences } : {}),
      ...(presentation.fields ? { fields: presentation.fields } : {}),
    };
  }
  const review = cloudToolReview(block.name, block.args, locale);
  return review
    ? { title: capabilitySentenceText(review.sentence.action, review.slots, { locale: review.locale, timeZone: "UTC" }) }
    : null;
};

/**
 * What the call does or would do, as one sentence; `null` for calls that only read. A stored review's action sentence
 * wins, so it reads the same after a reload and after the app changed. An old review's message is the question of the
 * card, not the call's short subject: steps and receipts keep the app's catalog sentence.
 */
export const toolSubject = (block: ToolBlock, locale: string, timeZone: string): string | null => {
  const review = reviewOf(block);
  if (review && !isLegacyActionReview(review))
    return capabilitySentenceText(review.sentence.action, review.slots, { locale: review.locale, timeZone });
  const cloudReview = cloudToolReview(block.name, block.args, locale);
  if (cloudReview) return capabilitySentenceText(cloudReview.sentence.action, cloudReview.slots, { locale: cloudReview.locale, timeZone });
  const wording = toolWording(block, locale);
  return wording ? capabilityActionSubject(wording, block.args, { locale, timeZone }) : null;
};

/** The sentence for one outcome, or `null` when the tool has none that renders for this call. */
export const toolOutcome = (block: ToolBlock, key: "done" | "rejected" | "notRun", locale: string, timeZone: string): string | null => {
  const result = isRecord(block.result) ? block.result : undefined;
  const review = reviewOf(block);
  if (review && !isLegacyActionReview(review)) {
    const receipt = key === "done" ? CapabilityActionReceiptSchema.safeParse(result?.receipt) : null;
    if (receipt?.success) return capabilitySentenceText(receipt.data.text, receipt.data.slots ?? {}, { locale: review.locale, timeZone });
    return capabilityReviewSentence(review, key, { timeZone });
  }
  if (review && key === "done" && review.legacy.summary) return review.legacy.summary;
  const cloudReview = cloudToolReview(block.name, block.args, locale);
  // Only a form the tool names; otherwise the card keeps Cloud's own outcome words for the call.
  if (cloudReview) return key === "done" || cloudReview.sentence[key] ? capabilityReviewSentence(cloudReview, key, { timeZone }) : null;
  const wording = toolWording(block, locale);
  if (!wording) return null;
  // App Actions return their data inside the result envelope; Cloud tools return the data itself.
  const data = block.presentation?.kind === "capability" ? result?.data : block.result;
  return capabilityActionOutcome(wording, key, { input: block.args, data }, { locale, timeZone });
};
