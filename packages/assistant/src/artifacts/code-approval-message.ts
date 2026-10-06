import { text } from "@k2b/stdlib";
import { artifactMessages } from "./messages";
import { reviewMessages } from "./review-messages";
import type { CodeApproval } from "./runtime/capabilities";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The text a person approves in chat when managed code asks for a capability Action or an external HTTP request.
 * Nessi carries only this text, so it names the app and Action, repeats the owning app's localized review, and lists
 * each reviewed value as a "Label: value" line that the approval card shows as a row. It never contains a secret value.
 */
export function codeApprovalMessage(approval: CodeApproval, locale: string): string {
  const artifact = artifactMessages.resolve([locale]).t;
  const t = reviewMessages.resolve([locale]).t;
  if ("type" in approval) {
    return [
      `${artifact.httpRequest}: ${approval.method} ${approval.url}`,
      ...(approval.resourceTitle ? [`${t.appResource}: ${approval.resourceTitle}`] : []),
      artifact.httpConsent,
      ...Object.entries(approval.headers).map(
        ([name, value]) => `${name}: ${typeof value === "string" ? value : `${value.prefix}[${t.secret({ name: value.secret })}]`}`,
      ),
      ...(approval.bodyBytes ? [`${t.body({ size: text.pprintBytes(approval.bodyBytes, { locale }) })}: ${approval.bodyPreview}`] : []),
      ...(approval.bodyTruncated ? [artifact.httpTruncated] : []),
    ].join("\n");
  }
  const reviewed = approval.review
    ? [
        approval.review.message,
        ...(approval.review.details ?? []).map((detail) =>
          detail.display === "block" ? `${detail.label}:\n${detail.value}` : `${detail.label}: ${detail.value}`,
        ),
      ]
    : // Without an app review, the exact input fields are what the person approves.
      Object.entries(isRecord(approval.input) ? approval.input : {}).map(
        ([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
      );
  return [
    `${approval.appName}: ${approval.title}`,
    ...(approval.resource ? [`${t.appResource}: ${approval.resource.title}`, artifact.sharedCodeHelp] : []),
    ...reviewed,
  ].join("\n");
}
