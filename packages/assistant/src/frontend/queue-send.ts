/** What a queued message's "Send now" reports back, as Cloud answers it. */
export type QueueSendResult = { state: "sending" | "submitted" | "failed" };

/**
 * "Send now" for one queued entry. Cloud answers whether it stopped the running turn and sent the entry. When that
 * answer is lost, the chat first reads the queue again: an entry that still waits was not sent, so it offers "Send
 * again", which reuses the entry's ID; one that left the queue or is being sent went out. Nothing is sent twice.
 */
export const sendQueuedEntryNow = async (input: {
  id: string;
  send: () => Promise<QueueSendResult>;
  reload: () => Promise<readonly { id: string; state: string }[]>;
}): Promise<"sent" | "not-sent"> => {
  try {
    const result = await input.send();
    await input.reload().catch(() => undefined);
    return result.state === "failed" ? "not-sent" : "sent";
  } catch {
    try {
      const entries = await input.reload();
      return entries.some((entry) => entry.id === input.id && entry.state !== "sending") ? "not-sent" : "sent";
    } catch {
      return "not-sent";
    }
  }
};
