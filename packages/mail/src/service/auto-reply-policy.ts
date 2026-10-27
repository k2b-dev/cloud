import type { MessageProtocolFacts } from "./message-protocol";

const autoReplySuppressionReasons = [
  "missing_sender",
  "null_return_path",
  "mailbox_sender",
  "automated_message",
  "bulk_message",
  "mailing_list",
  "sender_suppressed",
  "delivery_status",
  "already_replied",
] as const;

export type AutoReplySuppressionReason = (typeof autoReplySuppressionReasons)[number];

export type AutoReplyFacts = {
  senderAddresses: readonly string[];
  mailboxAddresses: readonly string[];
  returnPath?: string | null;
  autoSubmitted?: string | null;
  precedence?: string | null;
  listId?: string | null;
  autoResponseSuppress?: string | null;
  deliveryStatus?: boolean;
  alreadyReplied?: boolean;
};

type AutoReplyPolicyDecision = { allowed: true; reasons: readonly [] } | { allowed: false; reasons: readonly AutoReplySuppressionReason[] };

const normalizeAddress = (value: string): string => value.trim().replace(/^<|>$/g, "").toLowerCase();
const normalizeHeader = (value: string | null | undefined): string => value?.trim().toLowerCase() ?? "";

export const parseReturnPathAddress = (value: string | null | undefined): string | null => {
  const source = value?.trim() ?? "";
  if (source === "" || source === "<>") return null;
  const candidate = source.startsWith("<") && source.endsWith(">") ? source.slice(1, -1).trim() : source;
  return /^[^<>\s,]+@[^<>\s,]+$/u.test(candidate) ? candidate.toLowerCase() : null;
};

/** Shared classification for workflow conditions and automatic-reply loop guards. */
export const automatedMailReasons = (
  facts: Pick<AutoReplyFacts, "autoSubmitted" | "precedence" | "listId">,
): AutoReplySuppressionReason[] => {
  const reasons: AutoReplySuppressionReason[] = [];
  const autoSubmitted = normalizeHeader(facts.autoSubmitted);
  if (autoSubmitted !== "" && autoSubmitted !== "no") reasons.push("automated_message");
  if (["bulk", "list", "junk"].includes(normalizeHeader(facts.precedence))) reasons.push("bulk_message");
  if (normalizeHeader(facts.listId) !== "") reasons.push("mailing_list");
  return reasons;
};

/**
 * Evaluates protocol-level loop guards only. Business rules and rate limits are
 * applied separately so this decision remains deterministic and auditable.
 */
export const evaluateAutoReplyPolicy = (facts: AutoReplyFacts): AutoReplyPolicyDecision => {
  const reasons: AutoReplySuppressionReason[] = [];
  const senders = new Set(facts.senderAddresses.map(normalizeAddress).filter(Boolean));
  const mailboxAddresses = new Set(facts.mailboxAddresses.map(normalizeAddress).filter(Boolean));
  const returnPath = normalizeHeader(facts.returnPath);
  const suppressTokens = new Set(
    normalizeHeader(facts.autoResponseSuppress)
      .split(/[\s,]+/)
      .filter(Boolean),
  );

  if (senders.size === 0) reasons.push("missing_sender");
  if (returnPath === "<>" || returnPath === "") reasons.push("null_return_path");
  if ([...senders].some((address) => mailboxAddresses.has(address))) reasons.push("mailbox_sender");
  reasons.push(...automatedMailReasons(facts));
  if (["all", "autoreply", "oof"].some((token) => suppressTokens.has(token))) reasons.push("sender_suppressed");
  if (facts.deliveryStatus === true) reasons.push("delivery_status");
  if (facts.alreadyReplied === true) reasons.push("already_replied");

  return reasons.length === 0 ? { allowed: true, reasons: [] } : { allowed: false, reasons };
};

export const autoReplyFactsFromProtocol = (
  protocolFacts: MessageProtocolFacts,
): Pick<AutoReplyFacts, "returnPath" | "autoSubmitted" | "precedence" | "listId" | "autoResponseSuppress" | "deliveryStatus"> => ({
  returnPath: protocolFacts.returnPath,
  autoSubmitted: protocolFacts.autoSubmitted,
  precedence: protocolFacts.precedence,
  listId: protocolFacts.list.id,
  autoResponseSuppress: protocolFacts.autoResponseSuppress,
  deliveryStatus: protocolFacts.deliveryStatus,
});
