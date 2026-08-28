import { type DateContext, dates } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Button, DetailPanel, Placeholder, useLocale } from "@k2b/ui";
import { createMemo, For, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { RelatedConversationSummary } from "../../contracts";
import { readApiError } from "./api-response";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";

export function MailRelatedConversationsView(props: {
  mailboxId: string;
  items?: RelatedConversationSummary[];
  loading: boolean;
  error: string | null;
  dateConfig: DateContext;
  onRetry: () => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const reasonLabel = (reason: RelatedConversationSummary["reasons"][number]): string =>
    reason.kind === "subject" ? t().sameSubject : t().alsoWith({ value: reason.value });
  return (
    <DetailPanel.Section title={t().relatedMail} icon="ti ti-mail-search" tone="neutral" meta={props.items?.length}>
      <Show when={!props.loading} fallback={<Placeholder state="loading" variant="compact" align="center" title={t().findingRelated} />}>
        <Show
          when={!props.error}
          fallback={
            <Placeholder
              state="error"
              variant="compact"
              align="center"
              title={t().relatedUnavailable}
              description={props.error ?? undefined}
              action={
                <Button variant="secondary" size="sm" type="button" onClick={props.onRetry}>
                  {t().retry}
                </Button>
              }
            />
          }
        >
          <Show
            when={(props.items?.length ?? 0) > 0}
            fallback={
              <Placeholder
                state="empty"
                variant="compact"
                align="center"
                icon="ti ti-mail-off"
                title={t().noRelated}
                description={t().noRelatedDescription}
              />
            }
          >
            <div class="flex flex-col gap-1">
              <For each={props.items}>
                {(item) => (
                  <DetailPanel.Action
                    href={`/app/mail/${encodeURIComponent(props.mailboxId)}?conversation=${encodeURIComponent(item.id)}`}
                    leading={<i class="ti ti-mail" aria-hidden="true" />}
                    title={item.subject.trim() || t().noSubject}
                    description={`${item.reasons.map(reasonLabel).join(" · ")} · ${dates.formatDateTimeRelative(item.latestMessageAt, props.dateConfig)}`}
                    trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </DetailPanel.Section>
  );
}

export default function MailRelatedConversations(props: {
  mailboxId: string;
  conversationId: string;
  active: boolean;
  dateConfig: DateContext;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const related = query.create<readonly [string, string], RelatedConversationSummary[]>({
    source: () => [props.mailboxId, props.conversationId] as const,
    enabled: () => props.active,
    load: async ([mailboxId, conversationId], { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].related.$get(
        {
          param: { mailboxId, conversationId },
          query: { limit: "5" },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().loadRelatedFailed));
      return response.json();
    },
  });

  return (
    <MailRelatedConversationsView
      mailboxId={props.mailboxId}
      items={related.data()}
      loading={related.loading()}
      error={related.error()?.message ?? null}
      dateConfig={props.dateConfig}
      onRetry={() => void related.refresh()}
    />
  );
}
