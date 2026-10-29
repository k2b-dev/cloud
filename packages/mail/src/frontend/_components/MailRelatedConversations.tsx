import { type DateContext, dates } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { DetailPanel, Placeholder, useLocale } from "@k2b/ui";
import { createMemo, For, Match, Switch } from "solid-js";
import { apiClient } from "../../api/client";
import type { RelatedConversationSummary } from "../../contracts";
import { readApiError } from "./api-response";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";

/**
 * Related conversations as rows of the "Linked" section. Loading and a failed load stay on one quiet line; an empty
 * result shows nothing, so the section's other links and its count speak for it.
 */
export function MailRelatedConversationsView(props: {
  mailboxId: string;
  items?: RelatedConversationSummary[];
  loading: boolean;
  error: string | null;
  /** The sentence a failed load shows; the error itself is the fallback. */
  unavailableText?: string;
  dateConfig: DateContext;
  onRetry: () => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const reasonLabel = (reason: RelatedConversationSummary["reasons"][number]): string =>
    reason.kind === "subject" ? t().sameSubject : t().alsoWith({ value: reason.value });
  return (
    <Switch>
      <Match when={props.loading}>
        <Placeholder state="loading" variant="inline" align="left" title={t().findingRelated} />
      </Match>
      <Match when={props.error}>
        {(error) => (
          <Placeholder state="error" variant="compact" align="left" title={props.unavailableText ?? error()} onRetry={props.onRetry} />
        )}
      </Match>
      <Match when={(props.items?.length ?? 0) > 0}>
        <For each={props.items}>
          {(item) => (
            <DetailPanel.Action
              href={`/app/mail/${encodeURIComponent(props.mailboxId)}?conversation=${encodeURIComponent(item.id)}`}
              leading={<i class="ti ti-mail" aria-hidden="true" />}
              title={item.subject.trim() || t().noSubject}
              description={`${item.reasons.map(reasonLabel).join(" · ")} · ${dates.formatDateTimeRelative(item.latestMessageAt, props.dateConfig)}`}
            />
          )}
        </For>
      </Match>
    </Switch>
  );
}

/** Loads up to five conversations related to this one while the panel is open. */
export const createRelatedConversations = (props: {
  mailboxId: () => string;
  conversationId: () => string;
  enabled: () => boolean;
  failedLabel: () => string;
}) =>
  query.create<readonly [string, string], RelatedConversationSummary[]>({
    source: () => [props.mailboxId(), props.conversationId()] as const,
    enabled: props.enabled,
    load: async ([mailboxId, conversationId], { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].related.$get(
        {
          param: { mailboxId, conversationId },
          query: { limit: "5" },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, props.failedLabel()));
      return response.json();
    },
  });
