import { type DateContext, dates } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Button, NoticeCard, Placeholder, ScrollArea } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { SenderIdentity } from "../../contracts";
import type { MessageDetail, MessageSummary } from "../../service/messages";
import { assertCursorProgress } from "../pagination";
import { readApiError } from "./api-response";
import MailMessageAttachments from "./MailMessageAttachments";
import MailMessageBody from "./MailMessageBody";
import { formatMailAddress } from "./mail-compose-derivation";
import { isOutgoingMessage, mergeLatestMessagePages } from "./mail-conversation-history";
import { formatMailMessageDateTime } from "./mail-message-presentation";

type MessagePage = { items: MessageSummary[]; nextCursor: string | null };

const MailComposerHistoryBody = (props: { mailboxId: string; message: MessageSummary; expanded: boolean }) => {
  const detail = query.create<string, MessageDetail>({
    source: () => props.message.id,
    enabled: () => props.expanded,
    load: async (messageId, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].messages[":messageId"].$get(
        { param: { mailboxId: props.mailboxId, messageId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "Could not load this message"));
      return response.json();
    },
  });
  const current = () => {
    const value = detail.data();
    return value?.id === props.message.id ? value : null;
  };

  return (
    <Show when={props.expanded}>
      <div class="px-3 py-3">
        <Show
          when={current()}
          fallback={
            <Show when={detail.error()} fallback={<Placeholder state="loading" variant="compact" title="Loading message..." />}>
              {(error) => (
                <Placeholder
                  state="error"
                  variant="compact"
                  title="Could not load this message"
                  description={error().message}
                  action={
                    <Button variant="secondary" size="sm" type="button" onClick={() => void detail.refresh()}>
                      Retry
                    </Button>
                  }
                />
              )}
            </Show>
          }
        >
          {(message) => {
            const linksDisabled = () => message().security?.linksDisabled === true;
            const format = (): "plain" | "html" => (message().plainText ? "plain" : "html");
            return (
              <div class="flex flex-col gap-3">
                <Show when={message().security && message().security?.risk !== "none"}>
                  <NoticeCard tone="warning" icon="ti ti-shield-exclamation">
                    This message may be unsafe. Links and attachments follow the same protections as in the Mail reader.
                  </NoticeCard>
                </Show>
                <Show
                  when={message().plainText || message().sanitizedHtml}
                  fallback={
                    <Placeholder
                      state={message().hydrationStatus === "failed" ? "error" : "empty"}
                      variant="compact"
                      title={
                        message().hydrationStatus === "failed" ? "The message body could not be synchronized" : "This message has no body"
                      }
                    />
                  }
                >
                  <div class="mail-message-body min-w-0 overflow-x-auto text-sm text-primary">
                    <MailMessageBody
                      mailboxId={props.mailboxId}
                      messageId={message().id}
                      format={format()}
                      html={message().sanitizedHtml}
                      plainText={message().plainText}
                      attachments={message().attachments}
                      remoteContent={message().remoteContent}
                      linksDisabled={linksDisabled()}
                      onSelectionChange={() => undefined}
                    />
                  </div>
                </Show>
                <Show when={message().attachments.length > 0 && !linksDisabled()}>
                  <MailMessageAttachments
                    mailboxId={props.mailboxId}
                    messageId={message().id}
                    attachments={message().attachments}
                    canShare={false}
                  />
                </Show>
              </div>
            );
          }}
        </Show>
      </div>
    </Show>
  );
};

export default function MailComposerHistory(props: {
  mailboxId: string;
  conversationId: string;
  identities: SenderIdentity[];
  dateConfig: DateContext;
  active: () => boolean;
}) {
  const history = query.createInfinite<string, MessagePage, string>({
    source: () => props.conversationId,
    enabled: props.active,
    loadPage: async (conversationId, { cursor, abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].messages.$get(
        {
          param: { mailboxId: props.mailboxId, conversationId },
          query: { cursor, limit: "25", latest: "true" },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "Could not load conversation history"));
      const page = await response.json();
      assertCursorProgress(cursor, page.nextCursor, "conversation history");
      return page;
    },
    getNextCursor: (page) => page.nextCursor,
  });
  const messages = createMemo(() => mergeLatestMessagePages(history.pages()));
  const [expandedMessageIds, setExpandedMessageIds] = createSignal<Set<string>>(new Set());
  let initializedConversationId: string | null = null;

  createEffect(() => {
    if (initializedConversationId === props.conversationId) return;
    const firstMessageId = messages()[0]?.id;
    if (!firstMessageId) return;
    initializedConversationId = props.conversationId;
    setExpandedMessageIds(new Set([firstMessageId]));
  });

  const toggleMessage = (messageId: string) => {
    setExpandedMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  };

  return (
    <section class="flex h-full min-h-72 flex-col overflow-hidden bg-[var(--ui-surface)]" aria-label="Conversation history">
      <ScrollArea class="flex-1">
        <Show when={!history.loading()} fallback={<Placeholder state="loading" variant="panel" title="Loading conversation history..." />}>
          <Show
            when={messages().length > 0}
            fallback={
              <Show
                when={history.error()}
                fallback={
                  <Placeholder
                    state="empty"
                    variant="panel"
                    icon="ti ti-history-off"
                    title="No earlier messages"
                    description="This conversation does not contain any delivered messages yet."
                  />
                }
              >
                {(error) => (
                  <Placeholder
                    state="error"
                    variant="panel"
                    title="Could not load conversation history"
                    description={error().message}
                    action={
                      <Button variant="secondary" size="sm" type="button" onClick={() => void history.refresh()}>
                        Retry
                      </Button>
                    }
                  />
                )}
              </Show>
            }
          >
            <Show when={history.error()}>
              {(error) => (
                <NoticeCard tone="warning" icon="ti ti-refresh-alert" class="m-3">
                  <span>{error().message}</span>{" "}
                  <button type="button" class="font-semibold underline" onClick={() => void history.refresh()}>
                    Retry
                  </button>
                </NoticeCard>
              )}
            </Show>
            <div class="flex flex-col gap-2">
              <For each={messages()}>
                {(message) => {
                  const expanded = () => expandedMessageIds().has(message.id);
                  const outgoing = () => isOutgoingMessage(message, props.identities);
                  const sender = () => message.from.map(formatMailAddress).join(", ") || "Unknown sender";
                  const recipients = () => message.to.map(formatMailAddress).join(", ") || "undisclosed recipients";
                  return (
                    <article>
                      <button
                        type="button"
                        class="grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] px-3 py-2.5 text-left hover:bg-[var(--ui-hover)] focus-visible:bg-[var(--ui-hover)]"
                        aria-expanded={expanded()}
                        onClick={() => toggleMessage(message.id)}
                      >
                        <span class="min-w-0">
                          <span class="flex min-w-0 items-center gap-2">
                            <i
                              class={`ti ${outgoing() ? "ti-arrow-up-right" : "ti-arrow-down-left"} shrink-0 text-dimmed`}
                              aria-hidden="true"
                            />
                            <span class="truncate text-sm font-semibold text-primary">{outgoing() ? "You" : sender()}</span>
                            <span class="truncate text-xs text-dimmed">{outgoing() ? `to ${recipients()}` : "to me"}</span>
                          </span>
                          <span class="mt-0.5 block truncate text-xs text-secondary">{message.subject || "(no subject)"}</span>
                        </span>
                        <span class="flex items-center gap-2 text-xs text-dimmed">
                          <time dateTime={message.internalDate} title={dates.formatDateTime(message.internalDate, props.dateConfig)}>
                            {formatMailMessageDateTime(message.internalDate, props.dateConfig)}
                          </time>
                          <i class={`ti ${expanded() ? "ti-chevron-up" : "ti-chevron-down"}`} aria-hidden="true" />
                        </span>
                      </button>
                      <MailComposerHistoryBody mailboxId={props.mailboxId} message={message} expanded={expanded()} />
                    </article>
                  );
                }}
              </For>
            </div>
            <Show when={history.hasMore()}>
              <div class="flex justify-center p-3">
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  loading={history.loadingMore()}
                  disabled={history.loadingMore()}
                  onClick={() => void history.loadMore()}
                >
                  Load earlier messages
                </Button>
              </div>
            </Show>
          </Show>
        </Show>
      </ScrollArea>
    </section>
  );
}
