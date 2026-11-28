import type { MailSecurityFinding } from "../../security-contracts";
import type { mailMessageMessages } from "./mail-message-messages";

type MessageWords = ReturnType<typeof mailMessageMessages.resolve>["t"];

/** A security finding in the reader's words; a code the reader does not know keeps the server's title and explanation. */
export const mailSecurityFindingPresentation = (finding: MailSecurityFinding, t: MessageWords): { title: string; explanation: string } => {
  if (finding.code === "admin_deny_policy") return { title: t.blockedByOrganization, explanation: t.blockedByOrganizationExplanation };
  if (finding.code === "authentication_failed") {
    return { title: t.senderVerificationFailed, explanation: t.senderVerificationFailedExplanation };
  }
  if (finding.code === "reply_to_mismatch") return { title: t.repliesAnotherDomain, explanation: t.repliesAnotherDomainExplanation };
  if (finding.code === "misleading_link") return { title: t.unexpectedLink, explanation: t.unexpectedLinkExplanation };
  if (finding.code === "protected_identity_mismatch") {
    return { title: t.senderNameImpersonated, explanation: t.senderNameImpersonatedExplanation };
  }
  return finding;
};

/**
 * Whether a forward of this message goes without its attachments: a policy turns off the message's links, and the
 * server leaves its attachments out of every copy, so the reply box says so once.
 */
export const forwardLeavesAttachmentsOut = (
  mode: string,
  message: { attachments: readonly unknown[]; security?: { linksDisabled: boolean } | null } | null | undefined,
): boolean => mode === "forward" && (message?.attachments.length ?? 0) > 0 && Boolean(message?.security?.linksDisabled);
