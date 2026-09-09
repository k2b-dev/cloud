import { MarkdownView, prompts, toast } from "@k2b/ui";
import type { AccountActionNoticeInput } from "@k2b/cloud/shared";
import { apiClient } from "../api/client";
import type { AccountsMessages } from "./messages";

/** Never turn a successful mutation into a failure because a follow-up failed. */
export const showAccountActionNotice = async (
  input: AccountActionNoticeInput,
  messages: Pick<AccountsMessages, "actionNotice" | "creationNoticeFailed">,
) => {
  try {
    // A non-essential follow-up gets five seconds; the completed action must
    // remain usable even when the notice endpoint is unavailable.
    const response = await apiClient["action-notice"].$post({ json: input }, { init: { signal: AbortSignal.timeout(5_000) } });
    if (!response.ok) throw new Error("Notice unavailable");
    const notice = await response.json();
    if (notice.failed) throw new Error("Notice unavailable");
    if (notice.markdown) await prompts.alert(<MarkdownView markdown={notice.markdown} />, { title: messages.actionNotice });
  } catch {
    toast.error(messages.creationNoticeFailed);
  }
};
