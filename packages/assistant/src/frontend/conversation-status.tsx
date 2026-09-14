import type { AiConversation } from "@k2b/cloud/ai";
import { useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { conversationStatusPresentation } from "./conversation-view";
import { assistantMessages } from "./messages";

export function ConversationStatusMeta(props: { conversation: AiConversation; active?: boolean; labels?: boolean; hideStatus?: boolean; fallbackLabel?: string }) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const status = () => (props.hideStatus ? null : conversationStatusPresentation(props.conversation, locale(), props.active));
  return (
    <span class="assistant-conversation-status inline-flex shrink-0 items-center gap-1.5 text-[11px] text-dimmed">
      <Show when={props.conversation.pinnedAt}>
        <span class="inline-flex items-center gap-1" title={t().pinnedLabel}>
          <i class="ti ti-pin-filled text-xs" aria-hidden="true" />
          <Show when={props.labels}>{t().pinnedLabel}</Show>
          <Show when={!props.labels}>
            <span class="sr-only">{t().pinnedLabel}</span>
          </Show>
        </span>
      </Show>
      <Show when={status()} fallback={props.labels ? props.fallbackLabel : undefined}>
        {(item) => (
          <span class={`inline-flex items-center gap-1 ${item().class}`} title={item().label}>
            <i class={`${item().icon} text-xs`} aria-hidden="true" />
            <Show when={props.labels}><span class="assistant-conversation-status-label">{item().label}</span></Show>
            <Show when={!props.labels}>
              <span class="sr-only">{item().label}</span>
            </Show>
          </span>
        )}
      </Show>
    </span>
  );
}
