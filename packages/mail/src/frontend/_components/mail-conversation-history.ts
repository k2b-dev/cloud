type HistoryMessage = {
  id: string;
  from: Array<{ address: string }>;
};

type HistoryIdentity = {
  fromAddress: string;
  status: string;
};

const normalizedAddress = (value: string): string => value.trim().toLowerCase();

export const isOutgoingMessage = (message: Pick<HistoryMessage, "from">, identities: HistoryIdentity[]): boolean => {
  const ownAddresses = new Set(
    identities.filter((identity) => identity.status === "verified").map((identity) => normalizedAddress(identity.fromAddress)),
  );
  return message.from.some((sender) => ownAddresses.has(normalizedAddress(sender.address)));
};

export const mergeLatestMessagePages = <T extends { id: string }>(pages: readonly { items: readonly T[] }[]): T[] => {
  const messages = new Map<string, T>();
  for (const page of pages) {
    for (const message of page.items.toReversed()) {
      if (!messages.has(message.id)) messages.set(message.id, message);
    }
  }
  return [...messages.values()];
};

export const initialConversationMessageId = (messages: readonly HistoryMessage[]): string | null => messages.at(-1)?.id ?? null;

/** The reader follows new messages while the person reads at the end of the conversation, where the newest one is. */
export const isNearConversationEnd = (
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = 96,
): boolean => metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;

/** With the reply box on top the newest message comes first, so the reader follows new messages near the start. */
export const isNearConversationStart = (metrics: { scrollTop: number }, threshold = 96): boolean => metrics.scrollTop <= threshold;
