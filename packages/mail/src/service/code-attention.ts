import { type CodeAttention, loadCodeAttention } from "@k2b/cloud/ssr";
import type { Context } from "hono";

/** How long a mailbox response waits for Core's Code answer after its own data is ready. */
export const MAILBOX_CODE_ATTENTION_GRACE_MS = 50;

/**
 * Starts asking Core about the mailbox's Code before the mailbox loads; `settle` waits at most the grace period
 * after that. A slow or unavailable Core only leaves the dot out, for the SSR page and in-place mailbox switches.
 */
export const startMailboxCodeAttention = (c: Context, publicMailboxId: string) => {
  const pending = loadCodeAttention(c, { type: "mail.mailbox", id: publicMailboxId });
  return {
    settle: (): Promise<CodeAttention | null> => Promise.race([pending, Bun.sleep(MAILBOX_CODE_ATTENTION_GRACE_MS).then(() => null)]),
  };
};
