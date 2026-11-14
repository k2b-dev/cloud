import { type DateContext, dates } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Avatar, Button, FileTypeIcon, NoticeCard, Placeholder, ScrollArea, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { SenderIdentity } from "../../contracts";
import type { ConversationComment } from "../../service/collaboration";
import type { MessageDetail, MessageSummary } from "../../service/messages";
import { assertCursorProgress } from "../pagination";
import { readApiError } from "./api-response";
import MailConversationNote from "./MailConversationNote";
import MailMessageAttachments from "./MailMessageAttachments";
import MailMessageBody from "./MailMessageBody";
import { formatMailAddress } from "./mail-compose-derivation";
import { mailComposerMessages } from "./mail-composer-messages";
import { isOutgoingMessage, mergeLatestMessagePages } from "./mail-conversation-history";
import { formatMailMessageDateTime } from "./mail-message-presentation";
import type { MailReplyPosition } from "./mail-workspace-preferences";

type MessagePage = { items: MessageSummary[]; nextCursor: string | null };

/** One file of a message with "Attach to reply": it waits while it attaches and says so when it could not. */
const HistoryAttachmentChip = (props: {
  attachment: MessageDetail["attachments"][number];
  messageId: string;
  attach: (attachment: MessageDetail["attachments"][number], messageId: string) => Promise<void>;
}) => {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  const name = () => props.attachment.filename ?? t().attachment;
  return (
    <li class="mail-composer-history-file">
      <FileTypeIcon name={name()} mediaType={props.attachment.contentType} />
      <span class="mail-composer-history-file-name">{name()}</span>
      <Button
        variant="ghost"
        size="xs"
        type="button"
        loading={busy()}
        aria-label={t().attachToReplyNamed({ name: name() })}
        onClick={async () => {
          setBusy(true);
          try {
            await props.attach(props.attachment, props.messageId);
          } finally {
            setBusy(false);
          }
        }}
      >
        {t().attachToReply}
      </Button>
    </li>
  );
};

const MailComposerHistoryBody = (props: {
  mailboxId: string;
  message: MessageSummary;
  expanded: boolean;
  onAttach?: (attachment: MessageDetail["attachments"][number], messageId: string) => Promise<void>;
}) => {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const detail = query.create<string, MessageDetail>({
    source: () => props.message.id,
    enabled: () => props.expanded,
    load: async (messageId, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].messages[":messageId"].$get(
        { param: { mailboxId: props.mailboxId, messageId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().messageLoadFailed));
      return response.json();
    },
  });
  const current = () => {
    const value = detail.data();
    return value?.id === props.message.id ? value : null;
  };

  return (
    <Show when={props.expanded}>
      <div class="mail-composer-history-body">
        <Show
          when={current()}
          fallback={
            <Show when={detail.error()} fallback={<Placeholder state="loading" variant="compact" title={t().loadingMessage} />}>
              {(error) => (
                <Placeholder
                  state="error"
                  variant="compact"
                  title={t().messageLoadFailed}
                  description={error().message}
                  action={
                    <Button variant="secondary" size="sm" type="button" onClick={() => void detail.refresh()}>
                      {t().retry}
                    </Button>
                  }
                />
              )}
            </Show>
          }
        >
          {(message) => {
            const linksDisabled = () => message().security?.linksDisabled === true;
            const format = (): "plain" | "html" => (message().plainText?.trim() ? "plain" : "html");
            return (
              <div class="flex flex-col gap-3">
                <Show when={message().security && message().security?.risk !== "none"}>
                  <NoticeCard tone="warning">{t().unsafeMessage}</NoticeCard>
                </Show>
                <Show
                  when={message().plainText?.trim() || message().sanitizedHtml}
                  fallback={
                    <Placeholder
                      state={message().hydrationStatus === "failed" ? "error" : "empty"}
                      variant="compact"
                      title={message().hydrationStatus === "failed" ? t().bodySyncFailed : t().noMessageBody}
                    />
                  }
                >
                  <div class="mail-message-body min-w-0 overflow-x-auto text-sm text-primary">
                    <MailMessageBody
                      mailboxId={props.mailboxId}
                      messageId={message().id}
                      format={format()}
                      theme={null}
                      colors="original"
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
                  <Show
                    when={props.onAttach}
                    fallback={
                      <MailMessageAttachments
                        mailboxId={props.mailboxId}
                        messageId={message().id}
                        attachments={message().attachments}
                        canShare={false}
                      />
                    }
                  >
                    {(attach) => (
                      <ul class="mail-composer-history-files">
                        <For each={message().attachments.filter((attachment) => !attachment.contentId)}>
                          {(attachment) => <HistoryAttachmentChip attachment={attachment} messageId={message().id} attach={attach()} />}
                        </For>
                      </ul>
                    )}
                  </Show>
                </Show>
              </div>
            );
          }}
        </Show>
      </div>
    </Show>
  );
};

type HistoryAttachment = MessageDetail["attachments"][number];
type HistoryEntry = { kind: "message"; at: string; message: MessageSummary } | { kind: "note"; at: string; note: ConversationComment };

/**
 * The conversation beside a draft (compose page and large composer), read-only and in the reader's look: one avatar,
 * name, and time per message, the newest one open; internal notes as yellow tiles at their time. With `order` "top"
 * the newest message comes first, as with the reply box on top in the reader (F4). With `onAttach`, each attachment
 * offers "Attach to reply"; a failure says so and leaves the draft as it is.
 */
export default function MailComposerHistory(props: {
  mailboxId: string;
  conversationId: string;
  identities: SenderIdentity[];
  dateConfig: DateContext;
  active: () => boolean;
  order?: () => MailReplyPosition;
  onAttach?: (attachment: HistoryAttachment, messageId: string) => Promise<void>;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
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
      if (!response.ok) throw new Error(await readApiError(response, t().historyLoadFailed));
      const page = await response.json();
      assertCursorProgress(cursor, page.nextCursor, "conversation history");
      return page;
    },
    getNextCursor: (page) => page.nextCursor,
  });
  // Internal notes stand at their time between the messages; without them the conversation still reads.
  const notes = query.create<string, ConversationComment[]>({
    source: () => props.conversationId,
    enabled: props.active,
    load: async (conversationId, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].comments.$get(
        { param: { mailboxId: props.mailboxId, conversationId }, query: { order: "newest", limit: "50" } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) return [];
      return (await response.json()).items;
    },
  });
  const newestFirst = () => props.order?.() === "top";
  const messages = createMemo(() =>
    mergeLatestMessagePages(history.pages()).toSorted((left, right) => left.internalDate.localeCompare(right.internalDate)),
  );
  const entries = createMemo<HistoryEntry[]>(() => {
    const list: HistoryEntry[] = [
      ...messages().map((message) => ({ kind: "message" as const, at: message.internalDate, message })),
      ...(notes.data() ?? []).filter((note) => !note.deletedAt).map((note) => ({ kind: "note" as const, at: note.createdAt, note })),
    ].toSorted((left, right) => left.at.localeCompare(right.at));
    return newestFirst() ? list.toReversed() : list;
  });
  const [expandedMessageIds, setExpandedMessageIds] = createSignal<Set<string>>(new Set());
  let initializedConversationId: string | null = null;

  createEffect(() => {
    if (initializedConversationId === props.conversationId) return;
    const newest = messages().at(-1)?.id;
    if (!newest) return;
    initializedConversationId = props.conversationId;
    setExpandedMessageIds(new Set([newest]));
  });

  const toggleMessage = (messageId: string) => {
    setExpandedMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  };

  const earlier = () => (
    <Show when={history.hasMore()}>
      <div class="mail-composer-history-more">
        <Button
          variant="secondary"
          size="sm"
          type="button"
          loading={history.loadingMore()}
          disabled={history.loadingMore()}
          onClick={() => void history.loadMore()}
        >
          <i class="ti ti-dots" aria-hidden="true" /> {t().loadEarlier}
        </Button>
      </div>
    </Show>
  );

  return (
    <section class="mail-composer-history" aria-label={t().conversationHistory} data-order={newestFirst() ? "newest" : "oldest"}>
      <ScrollArea class="mail-composer-history-scroll">
        <Show
          when={!history.loading()}
          fallback={
            <div class="mail-composer-history-skeleton" role="status" aria-label={t().loadingHistory}>
              <span />
              <span />
              <span />
            </div>
          }
        >
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
                    title={t().noEarlierMessages}
                    description={t().noEarlierMessagesDescription}
                  />
                }
              >
                <Placeholder
                  state="error"
                  variant="panel"
                  title={t().historyFailedKeepsDraft}
                  action={
                    <Button variant="secondary" size="sm" type="button" onClick={() => void history.refresh()}>
                      {t().retry}
                    </Button>
                  }
                />
              </Show>
            }
          >
            <Show when={history.error()}>
              {(error) => (
                <NoticeCard tone="warning" class="m-3">
                  <span>{error().message}</span>{" "}
                  <button type="button" class="font-semibold underline" onClick={() => void history.refresh()}>
                    {t().retry}
                  </button>
                </NoticeCard>
              )}
            </Show>
            <Show when={!newestFirst()}>{earlier()}</Show>
            <div class="mail-composer-history-list">
              <For each={entries()}>
                {(entry) => (
                  <Show
                    when={entry.kind === "message" ? entry.message : null}
                    fallback={
                      <MailConversationNote
                        note={{ ...(entry as Extract<HistoryEntry, { kind: "note" }>).note, canEdit: false, canDelete: false }}
                        dateConfig={props.dateConfig}
                        saving={false}
                        onSave={async () => undefined}
                        onDelete={() => undefined}
                      />
                    }
                  >
                    {(message) => {
                      const expanded = () => expandedMessageIds().has(message().id);
                      const outgoing = () => isOutgoingMessage(message(), props.identities);
                      const sender = () => message().from.map(formatMailAddress).join(", ") || t().unknownSender;
                      const senderName = () => message().from[0]?.name || message().from[0]?.address || t().unknownSender;
                      const recipients = () => message().to.map(formatMailAddress).join(", ") || t().undisclosedRecipients;
                      return (
                        <article class="mail-composer-history-message" data-expanded={expanded() ? "" : undefined}>
                          <button
                            type="button"
                            class="mail-composer-history-head"
                            aria-expanded={expanded()}
                            onClick={() => toggleMessage(message().id)}
                          >
                            <Avatar name={senderName()} size="sm" />
                            <span class="mail-composer-history-who">
                              <span class="mail-composer-history-name" title={sender()}>
                                {outgoing() ? t().you : senderName()}
                              </span>
                              <Show
                                when={expanded()}
                                fallback={
                                  <span class="mail-composer-history-snippet">
                                    {message().preview || message().subject || t().noSubject}
                                  </span>
                                }
                              >
                                <span class="mail-composer-history-meta">
                                  {outgoing() ? t().toNamed({ value: recipients() }) : t().toMe} ·{" "}
                                  {formatMailMessageDateTime(message().internalDate, props.dateConfig)}
                                </span>
                              </Show>
                            </span>
                            <Show when={!expanded()}>
                              <span class="mail-composer-history-time">
                                <Show when={message().hasAttachments}>
                                  <i class="ti ti-paperclip" aria-hidden="true" />
                                </Show>
                                <time
                                  dateTime={message().internalDate}
                                  title={dates.formatDateTime(message().internalDate, props.dateConfig)}
                                >
                                  {formatMailMessageDateTime(message().internalDate, props.dateConfig)}
                                </time>
                              </span>
                            </Show>
                          </button>
                          <MailComposerHistoryBody
                            mailboxId={props.mailboxId}
                            message={message()}
                            expanded={expanded()}
                            onAttach={props.onAttach}
                          />
                        </article>
                      );
                    }}
                  </Show>
                )}
              </For>
            </div>
            <Show when={newestFirst()}>{earlier()}</Show>
          </Show>
        </Show>
      </ScrollArea>
    </section>
  );
}
