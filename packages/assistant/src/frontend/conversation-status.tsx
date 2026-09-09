import type { AiConversation } from "@k2b/cloud/ai";
import { useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { conversationStatusPresentation } from "./conversation-view";
import { assistantMessages } from "./messages";

export function ConversationStatusMeta(props: { conversation: AiConversation; labels?: boolean; hideStatus?: boolean }) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const status = () => (props.hideStatus ? null : conversationStatusPresentation(props.conversation, locale()));
  return (
    <span class="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-dimmed">
      <Show when={props.conversation.pinnedAt}>
        <span class="inline-flex items-center gap-1" title={t().pinnedLabel}>
          <i class="ti ti-pin-filled text-xs" aria-hidden="true" />
          <Show when={props.labels}>{t().pinnedLabel}</Show>
          <Show when={!props.labels}>
            <span class="sr-only">{t().pinnedLabel}</span>
          </Show>
        </span>
      </Show>
      <Show when={status()}>
        {(item) => (
          <span class={`inline-flex items-center gap-1 ${item().class}`} title={item().label}>
            <i class={`${item().icon} text-xs`} aria-hidden="true" />
            <Show when={props.labels}>{item().label}</Show>
            <Show when={!props.labels}>
              <span class="sr-only">{item().label}</span>
            </Show>
          </span>
        )}
      </Show>
    </span>
  );
}
