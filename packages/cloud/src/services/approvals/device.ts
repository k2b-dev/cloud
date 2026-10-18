import {
  APP_APPROVAL_LIMITS,
  type AppActionSummary,
  type AppActionView,
  appActionDigest,
  APP_ACTION_LIMITS as limits,
} from "../../contracts/app-approval";
import { CapabilityActionReviewSchema } from "../../contracts/capabilities";
import { DEFAULT_LOCALE } from "../../server/locale";
import type { PendingApprovalRow } from "./list";

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
  const lines = row.sentence.split(/\r?\n/).map(plain).filter(Boolean);
  const first = lines[0] ?? plain(row.action);
  const prefix = `${appName}: `;
  const sentence = first.startsWith(prefix) && first.length > prefix.length ? first.slice(prefix.length) : first;
  const review = CapabilityActionReviewSchema.safeParse(row.details);
  let message: string | null;
  const details: AppActionView["details"] = [];
  const detail = (label: string, value: string, format?: "date" | "date-time") => {
    if (details.length >= limits.details) {
      truncated = true;
      return;
    }
    const cleanedLabel = text(label, limits.labelChars);
    if (!cleanedLabel) return;
    details.push({ label: cleanedLabel, value: text(value, limits.valueChars), ...(format ? { format } : {}) });
  };
  const messages: string[] = [];
  const reviewLines = new Set<string>();
  if (review.success) {
    const cleaned = plain(review.data.message);
    if (cleaned !== sentence) messages.push(cleaned);
    reviewLines.add(cleaned);
    for (const line of review.data.message.split(/\r?\n/)) reviewLines.add(plain(line));
    for (const field of review.data.details ?? [])
      detail(field.label, field.value, field.format === "date" || field.format === "date-time" ? field.format : undefined);
  }
  for (const line of lines.slice(1)) {
    if (reviewLines.has(line)) continue;
    const match = /^([^:]{1,40}):\s+(.+)$/.exec(line);
    if (match) detail(match[1]!, match[2]!);
    else messages.push(line);
  }
  message = text(messages.join(" "), limits.messageChars) || null;
  const boundedSentence = text(sentence, limits.sentenceChars);
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
