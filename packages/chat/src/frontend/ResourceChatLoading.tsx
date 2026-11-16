import { Skeleton, useLocale } from "@k2b/ui";
import type { JSX } from "solid-js";
import { chatMessages } from "../messages";

/**
 * The discussion about the host page's place while the panel finds it, in the frame the discussion opens in: a place
 * shared after the panel loaded (such as after "Allow") shows this instead of the chat list it then leaves.
 */
export default function ResourceChatLoading(): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  return (
    <section class="chat-conversation chat-resource-start" aria-busy="true" aria-label={t().loadingResourceChat}>
      <header class="chat-conversation__header">
        <Skeleton class="chat-resource-loading__title" />
      </header>
      <div class="chat-conversation__feed chat-resource-start__feed">
        <span class="sr-only" role="status">
          {t().loadingResourceChat}
        </span>
      </div>
    </section>
  );
}
