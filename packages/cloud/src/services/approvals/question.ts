import { listCapabilities } from "../../_internal/registry";
import { type AiStoredActionReview, storedActionReview } from "../../ai/action-review";
import type { ActionCard } from "../../ai/chat/action-card";
import { approvalCard } from "../../approvals/approval-card";
import {
  type CapabilityActionPolicy,
  CapabilityActionReviewPresentationSchema,
  capabilityActionPolicy,
} from "../../contracts/capabilities";
import { DEFAULT_LOCALE } from "../../server/locale";
import type { PendingApprovalRow } from "./list";

/**
 * One open approval as the question card words it, for places outside the browser: Cloud Login and notifications.
 * The approvals page builds the same card from the same rows.
 */

/**
 * The declared policy of a row's Action, needed for new-shape reviews' device eligibility and fallback reason:
 * `undefined` when none is needed or declared, `null` when the registry could not say.
 */
export type ApprovalActionPolicy = CapabilityActionPolicy | null | undefined;
const needsPolicy = (row: PendingApprovalRow): boolean => {
  if (row.storedReview && "sentence" in row.storedReview) return true;
  const review = CapabilityActionReviewPresentationSchema.safeParse(row.details);
  return review.success;
};
/** Reads the registry once for the rows that need their Action's declared policy, as the approvals page does. */
export const loadApprovalActionPolicies = async (
  rows: readonly PendingApprovalRow[],
): Promise<(row: PendingApprovalRow) => ApprovalActionPolicy> => {
  if (!rows.some(needsPolicy)) return () => undefined;
  const capabilities = await listCapabilities().catch(() => null);
  return (row) => {
    if (!needsPolicy(row)) return undefined;
    if (capabilities === null) return null;
    // An app that is not registered right now cannot say why its Action asks either.
    const manifest = capabilities.find((entry) => entry.appId === row.appId)?.manifest;
    return manifest ? capabilityActionPolicy(manifest, row.action) : null;
  };
};

/** The open request binds the content; the turn supplies the declared reason for older snapshots. */
export const pendingApprovalReview = (
  row: Pick<PendingApprovalRow, "storedReview" | "details">,
  policy?: ApprovalActionPolicy,
): AiStoredActionReview | null => {
  const parsed = CapabilityActionReviewPresentationSchema.safeParse(row.details);
  if (parsed.success && "sentence" in parsed.data)
    return storedActionReview(
      { ...parsed.data, ask: parsed.data.ask ?? (row.storedReview && "sentence" in row.storedReview ? row.storedReview.ask : undefined) },
      policy,
    );
  return row.storedReview ?? (parsed.success ? storedActionReview(parsed.data, policy) : null);
};

/** Resolve the recorded question in the language and time zone of its originating turn. */
export const pendingApprovalCard = (
  row: PendingApprovalRow,
  appName: (appId: string, locale: string) => string,
  policy?: ApprovalActionPolicy,
  fallbackLocale = DEFAULT_LOCALE,
): ActionCard => {
  const locale = row.runConfig?.kind === "compact" ? fallbackLocale : (row.runConfig?.locale ?? fallbackLocale);
  const timeZone = row.runConfig?.kind === "compact" ? "UTC" : (row.runConfig?.timeZone ?? "UTC");
  const review = pendingApprovalReview(row, policy);
  return approvalCard(
    { sentence: row.sentence, action: row.action, appName: appName(row.appId, locale), appIcon: null, review },
    locale,
    timeZone,
  );
};
