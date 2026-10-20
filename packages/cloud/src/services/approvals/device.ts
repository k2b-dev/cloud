import { listApps } from "../../_internal/registry";
import { storedActionReview } from "../../ai/action-review";
import type { ActionCard } from "../../ai/chat/action-card";
import { type ActionQuestionText, actionCardText, actionNoteLabel } from "../../ai/chat/action-text";
import { approvalCard } from "../../approvals/approval-card";
import {
  APP_APPROVAL_LIMITS,
  type AppActionSummary,
  type AppActionView,
  appActionDigest,
  APP_ACTION_LIMITS as limits,
} from "../../contracts/app-approval";
import { CapabilityActionReviewDataSchema } from "../../contracts/capabilities";
import { DEFAULT_LOCALE } from "../../server/locale";
import { resolveAppIdentityPresentation } from "../../shared/app-presentation";
import { get } from ".";
import type { PendingApprovalRow } from "./list";
import { listPending } from "./list";

const plain = (value: string): string =>
  value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
const cut = (value: string, limit: number): string => {
  const points = Array.from(value);
  if (limit < 1) return "";
  return points.length > limit ? `${points.slice(0, limit - 1).join("")}…` : value;
};

export const appApprovalText = (value: string, limit: number): string => cut(plain(value), limit);

/** Resolve the recorded question in the language and time zone of its originating turn. */
export const pendingApprovalCard = (row: PendingApprovalRow, appName: (appId: string, locale: string) => string): ActionCard => {
  const locale = row.runConfig?.kind === "compact" ? DEFAULT_LOCALE : (row.runConfig?.locale ?? DEFAULT_LOCALE);
  const timeZone = row.runConfig?.kind === "compact" ? "UTC" : (row.runConfig?.timeZone ?? "UTC");
  const parsed = CapabilityActionReviewDataSchema.safeParse(row.details);
  const review = row.storedReview ?? (parsed.success ? storedActionReview(parsed.data) : null);
  return approvalCard(
    { sentence: row.sentence, action: row.action, appName: appName(row.appId, locale), appIcon: null, review },
    locale,
    timeZone,
  );
};

/** Incomplete sends must be decided with the complete review in the browser. */
export const appActionOffered = (view: AppActionView, question: ActionCard | ActionQuestionText): boolean =>
  !(("reasonCode" in question ? question.reasonCode : question.reason.code) === "sends" && view.truncated);

/** A deterministic, plain-text snapshot; the digest binds the device's choice to everything it shows. */
export const appActionView = async (
  row: PendingApprovalRow,
  options: { issuer: string; appName: (appId: string, locale: string) => string },
): Promise<AppActionView> => {
  let truncated = false;
  const text = (value: string, limit: number) => {
    const cleaned = plain(value);
    const result = cut(cleaned, limit);
    if (result !== cleaned) truncated = true;
    return result;
  };
  const locale = row.runConfig?.kind === "compact" ? DEFAULT_LOCALE : (row.runConfig?.locale ?? DEFAULT_LOCALE);
  const appName = plain(options.appName(row.appId, locale));
  const app = { id: text(row.appId, limits.nameChars), name: text(appName, limits.nameChars) };
  const requester = {
    app: { id: text(row.requesterAppId, limits.nameChars), name: text(options.appName(row.requesterAppId, locale), limits.nameChars) },
    // The snapshot, so renaming the chat does not change what the device signs.
    title: text(row.requesterTitle ?? "", limits.titleChars) || null,
  };
  const question = actionCardText(pendingApprovalCard(row, options.appName));
  truncated ||= question.incomplete;
  const details: AppActionView["details"] = [];
  for (const field of question.rows) {
    if (details.length >= limits.details) {
      truncated = true;
      break;
    }
    // The device protocol requires labels; a line an old review left unlabelled is shown as a note, not dropped.
    const label = text(field.label, limits.labelChars) || text(actionNoteLabel(question.locale), limits.labelChars);
    details.push({ label, value: text(field.value, limits.valueChars), ...(field.format ? { format: field.format } : {}) });
  }
  const message = text(question.reason, limits.messageChars) || null;
  const boundedSentence = text(question.question, limits.sentenceChars);
  const view: AppActionView = {
    actionId: row.id,
    app,
    requester,
    assurance: row.assurance,
    sentence: boundedSentence,
    message,
    details,
    truncated,
    argsDigest: row.argsDigest,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    // Reserve the digest's bytes while bounding the final response.
    digest: "A".repeat(43),
  };
  const bytes = () => new TextEncoder().encode(JSON.stringify(view)).length;
  while (bytes() > APP_APPROVAL_LIMITS.bodyBytes) {
    view.truncated = true;
    if (view.details.length) view.details.pop();
    else if (view.message) view.message = cut(view.message, Array.from(view.message).length - 1) || null;
    else break;
  }
  view.digest = await appActionDigest(options.issuer, view);
  return view;
};

export const appActionSummary = (view: AppActionView): AppActionSummary => ({
  actionId: view.actionId,
  app: view.app,
  requester: view.requester,
  assurance: view.assurance,
  sentence: cut(view.sentence, limits.summaryChars),
  createdAt: view.createdAt,
  expiresAt: view.expiresAt,
});

/** Whether a pending approval can wake a device under the same mapping used by its inbox and detail view. */
export const deviceOffersApproval = async (approvalId: string): Promise<boolean> => {
  const request = await get(approvalId);
  if (!request) return false;
  const { items } = await listPending({ approverUserId: request.approverUserId, id: approvalId, limit: 1 });
  const row = items[0];
  if (!row) return false;
  const apps = await listApps();
  const appName = (id: string, locale: string) => {
    const app = apps.find((entry) => entry.id === id);
    return app ? resolveAppIdentityPresentation(app, locale).name : id;
  };
  // Offering does not sign a decision; the issuer has no effect on truncation or eligibility.
  const view = await appActionView(row, { issuer: "", appName });
  return appActionOffered(view, pendingApprovalCard(row, appName));
};
