import { capabilityQuestionText, capabilityUnknownText } from "../_internal/capability-sentences";
import { isLegacyActionReview, storedActionReview, type AiStoredActionReview } from "../ai/action-review";
import { type ActionCard, legacyActionCard, reviewActionCard } from "../ai/chat/action-card";
import { aiChatMessages } from "../ai/chat/messages";
import type { CapabilityActionReviewData } from "../contracts/capabilities";

export type ApprovalCardInput = {
  sentence: string;
  action: string;
  appName: string;
  appIcon?: string | null;
  review: CapabilityActionReviewData | AiStoredActionReview | null;
};

const lines = (item: ApprovalCardInput) =>
  item.sentence
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** The first line names the app and the Action; the app already shows as the row's icon and origin. */
const approvalTitle = (item: ApprovalCardInput): string => {
  const first = lines(item)[0] ?? item.action;
  const prefix = `${item.appName}: `;
  return first.startsWith(prefix) && first.length > prefix.length ? first.slice(prefix.length) : first;
};

/** Without a review, the sentence's later `Label: value` lines are what the person approves. */
const sentenceRows = (item: ApprovalCardInput) =>
  lines(item)
    .slice(1)
    .map((line) => {
      const match = /^([^:]{1,40}):\s+(.+)$/.exec(line);
      return match ? { label: match[1]!, value: match[2] ?? "" } : { label: "", value: line };
    });

/**
 * The same card as the chat: a new review gives the app's sentence, reason, and preview; an old review its literal
 * message and rows; a request without a review its sentence. Times show in the reader's zone (UTC until the page
 * passes one, the same on the server and in the first browser render).
 */
export const approvalCard = (item: ApprovalCardInput, locale: string, timeZone: string): ActionCard => {
  const app = { name: item.appName, icon: item.appIcon ?? "ti ti-shield-check" };
  const context = { locale, timeZone, app };
  const review = item.review ? ("legacy" in item.review ? item.review : storedActionReview(item.review)) : null;
  if (review && !isLegacyActionReview(review)) return reviewActionCard(review, context);
  const title = approvalTitle(item);
  const t = aiChatMessages(locale);
  return legacyActionCard(
    {
      question: review?.legacy.question ?? capabilityQuestionText(title, locale),
      rows: review?.legacy.rows ?? sentenceRows(item),
      ...(review?.legacy.markdown ? { markdown: review.legacy.markdown } : {}),
      ...(review?.legacy.links ? { links: review.legacy.links } : {}),
      subject: title,
      title,
      outcome: {
        running: t.receiptRunning({ title }),
        done: t.receiptDone({ title }),
        rejected: t.receiptRejected({ title }),
        notRun: t.receiptNotRun({ title, stopped: false }),
        unknown: capabilityUnknownText(title, locale),
        unknownStill: capabilityUnknownText(title, locale, true),
      },
    },
    context,
  );
};
