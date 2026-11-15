/** What Cloud reports for a queued message's "Send now"; the same shape answers the later check. */
export type QueueSendResult = { state: "sending" | "submitted" | "failed" };

/**
 * "Send now" for one queued entry. Cloud answers whether it stopped the running turn and sent the entry. When that
 * answer is lost, the chat asks Cloud for the entry's receipt before it says anything: only a receipt that it is being
 * or was sent counts as sent. Absence from the queue proves nothing, since another device may have removed it. An
 * entry that was not sent offers "Send again", which reuses its ID, so nothing is sent twice. The queue is read again
 * either way.
 */
export const sendQueuedEntryNow = async (input: {
  send: () => Promise<QueueSendResult>;
  /** The entry's receipt, or `null` when Cloud does not know the entry. */
  receipt: () => Promise<QueueSendResult | null>;
  reload: () => Promise<unknown>;
}): Promise<"sent" | "not-sent"> => {
  let outcome: "sent" | "not-sent";
  try {
    outcome = (await input.send()).state === "failed" ? "not-sent" : "sent";
  } catch {
    const receipt = await input.receipt().catch(() => null);
    outcome = receipt && receipt.state !== "failed" ? "sent" : "not-sent";
  }
  await input.reload().catch(() => undefined);
  return outcome;
};
