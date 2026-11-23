import { importOnDemand } from "@k2b/cloud/browser/reload";
import type { DateContext } from "@k2b/stdlib";
import { toast, useLocale } from "@k2b/ui";
import { Avatar, Band, Bar, Button, Canvas, Chip, Inline, Notice, Pane, Row, Text, Tiles } from "@k2b/ui/v2";
import { type Accessor, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { SenderIdentity } from "../../../contracts";
import type { MailWorkspaceMessage } from "../../../service/workspace";
import type { MailboxController } from "../../mail-workspace";
import MailMessageBody from "../MailMessageBody";
import { isOutgoingMessage } from "../mail-conversation-history";
import { buildMailConversationTimeline } from "../mail-conversation-timeline";
import { mailMessageMessages } from "../mail-message-messages";
import { normalizeContentId, referencedContentIds, resolveMessageBodyFormat, resolveMessageColors } from "../mail-message-presentation";
import { buildMailListHref, mailRouteUrl } from "../mail-navigation";
import type { MailV2Text } from "./mail-v2-messages";
import { mailV2MessageTime } from "./mail-v2-time";

const attachmentIcon = (contentType: string, name: string): string => {
  if (contentType === "application/pdf" || name.toLowerCase().endsWith(".pdf")) return "file-type-pdf";
  if (contentType.startsWith("image/")) return "photo";
  if (contentType.startsWith("text/")) return "file-text";
  return "file";
};

const formatSize = (bytes: number, locale: string): string =>
  bytes < 1024 * 1024
    ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.max(1, Math.round(bytes / 1024)))} KB`
    : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} MB`;

/** One message of the open conversation: who wrote it, its text in its own sandboxed frame, its attachments. */
function MessageV2(props: {
  message: MailWorkspaceMessage;
  mailboxId: string;
  identities: SenderIdentity[];
  controller: MailboxController;
  dateConfig: DateContext;
  text: MailV2Text;
  /** Starts the reply to this conversation; absent where the person cannot write. */
  onReply?: () => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailMessageMessages.resolve([locale()]).t);
  const outgoing = () => isOutgoingMessage(props.message, props.identities);
  const sender = () => props.message.from[0];
  const senderName = () => (outgoing() ? t().you : sender()?.name || sender()?.address || t().unknownSender);
  const route = () => {
    const own = new Set(
      props.identities.filter((identity) => identity.status === "verified").map((identity) => identity.fromAddress.trim().toLowerCase()),
    );
    const recipients = props.message.to.map((address) => address.name || address.address).join(", ") || t().undisclosedRecipients;
    return !outgoing() && props.message.to.some((recipient) => own.has(recipient.address.trim().toLowerCase()))
      ? t().toMe
      : t().toRecipient({ recipients });
  };
  const when = () => mailV2MessageTime(props.message.sentAt ?? props.message.internalDate, props.dateConfig);
  const format = () =>
    resolveMessageBodyFormat(
      props.controller.userPreferences().readingFormat,
      null,
      Boolean(props.message.sanitizedHtml),
      Boolean(props.message.plainText?.trim()),
    );
  const attachmentHref = (id: string) => `/api/mail/mailboxes/${props.mailboxId}/messages/${props.message.id}/attachments/${id}`;
  // Images the text shows in place are part of the text, not attachments of their own.
  const attachments = () => {
    const inline = new Set(referencedContentIds(props.message.sanitizedHtml ?? "").map(normalizeContentId));
    return props.message.attachments.filter((attachment) => !attachment.contentId || !inline.has(normalizeContentId(attachment.contentId)));
  };
  const downloadAll = async () => {
    const files = attachments().map((attachment) => ({
      name: attachment.filename?.trim() || props.text.attachments,
      href: attachmentHref(attachment.id),
      size: attachment.sizeBytes,
    }));
    try {
      const zip = await importOnDemand(() => import("../mail-attachments-zip"));
      if (zip)
        await zip.downloadMailAttachments(
          files,
          `${props.message.subject.trim() || props.text.attachments}.zip`,
          new AbortController().signal,
        );
    } catch {
      toast.error(props.text.retry);
    }
  };
  return (
    <Band label={`${senderName()} · ${when()}`}>
      <Row
        avatar={{ name: senderName() }}
        strong
        lines={[senderName(), `${route()} · ${when()}`]}
        meta={outgoing() ? undefined : sender()?.address}
        end={
          <>
            <Show when={props.onReply}>
              {(reply) => <Button variant="ghost" icon="arrow-back-up" label={props.text.reply} onClick={() => reply()()} />}
            </Show>
            <Button variant="ghost" icon="dots" label={props.text.moreActions} disabled />
          </>
        }
      />
      <Show when={format()} fallback={<Text muted>{props.text.bodyLoading}</Text>}>
        {(bodyFormat) => (
          <Canvas label={props.text.messageText}>
            {/* The message's own document draws in its sandboxed frame; it stands on the text edge of the band. */}
            <div style={{ "padding-inline": "var(--k2-edge)" }}>
              <MailMessageBody
                mailboxId={props.mailboxId}
                messageId={props.message.id}
                format={bodyFormat()}
                theme={props.controller.theme()}
                colors={resolveMessageColors(props.controller.userPreferences().readingFormat, null)}
                html={props.message.sanitizedHtml}
                plainText={props.message.plainText}
                attachments={props.message.attachments}
                remoteContent={props.message.remoteContent}
                linksDisabled={props.message.security?.linksDisabled ?? false}
                onSelectionChange={() => undefined}
              />
            </div>
          </Canvas>
        )}
      </Show>
      <Show when={attachments().length > 0}>
        <Tiles
          label={props.text.attachments}
          items={attachments().map((attachment) => ({
            icon: attachmentIcon(attachment.contentType, attachment.filename ?? ""),
            title: attachment.filename?.trim() || props.text.attachments,
            meta: formatSize(attachment.sizeBytes, locale()),
            href: attachmentHref(attachment.id),
          }))}
          more={attachments().length > 1 ? { label: props.text.downloadAll, onClick: () => void downloadAll() } : undefined}
        />
      </Show>
    </Band>
  );
}

/**
 * The reader of Mail's v2 pilot: the open conversation's head with its actions, its state line, the short summary,
 * the reply and the messages, newest first, and the team's internal notes.
 */
export default function MailReaderV2(props: {
  controller: MailboxController;
  dateConfig: DateContext;
  text: MailV2Text;
  /** The reply composer; `request` counts the times a message's Reply asked it to start. */
  reply?: (request: Accessor<number>) => JSX.Element;
}) {
  const c = () => props.controller;
  const data = () => c().data;
  const item = () => c().selectedListItem();
  const listHref = () => buildMailListHref(mailRouteUrl(c().requestPath()));
  const [replyRequest, setReplyRequest] = createSignal(0);
  // Newest first, each internal note at the time it was written, as v1's reader with the reply on top.
  const timeline = createMemo(() => buildMailConversationTimeline(data().detailMessages, data().comments).reverse());
  const tags = () => data().conversationLocalTags?.tags ?? item()?.localTags ?? [];
  const assignees = () => data().collaborationState?.assignees ?? [];
  const readers = () => c().presence().participants;
  const workStatus = () => c().selectedWorkStatus();
  const run = (actionId: "archive" | "trash") => {
    const open = item();
    const target = open ? c().actionTargetForItem(open, actionId) : null;
    if (target) void c().runAction(actionId, { targets: [target] });
  };
  const statusChip = () => {
    const status = workStatus();
    if (status === "waiting") return <Chip status="warn">{c().sidebarText().waitingForReply}</Chip>;
    if (status === "done") return <Chip status="ok">{props.text.done_}</Chip>;
    return null;
  };

  return (
    <Pane
      detail
      label={props.text.messageText}
      head={
        <Bar
          start={<Text type="lead">{data().selectedSubject || c().t().noSubject}</Text>}
          end={
            <>
              <Show when={c().canWrite() && workStatus()}>
                <Button
                  icon={workStatus() === "done" ? "arrow-back-up" : "check"}
                  onClick={() => c().setOpenConversationCompletion(workStatus() === "done" ? "open" : "done")}
                  disabled={c().completion.loading()}
                >
                  {workStatus() === "done" ? props.text.reopen : props.text.done_}
                </Button>
              </Show>
              <Show when={c().canWrite()}>
                <Button variant="ghost" icon="archive" label={props.text.archive} onClick={() => run("archive")} />
                <Button variant="ghost" icon="trash" label={props.text.delete} onClick={() => run("trash")} />
                <Button variant="ghost" icon="clock" label={props.text.later} disabled />
              </Show>
              <Show when={c().assignment()}>
                <Show
                  when={assignees()[0]}
                  fallback={
                    <Button variant="ghost" icon="user-plus" label={props.text.assign} onClick={() => void c().assignOpenConversation()} />
                  }
                >
                  {(first) => (
                    <Button
                      variant="ghost"
                      avatar={{ name: first().displayName }}
                      label={props.text.assignedTo({ name: first().displayName })}
                      onClick={() => void c().assignOpenConversation()}
                    />
                  )}
                </Show>
              </Show>
              <Button variant="ghost" icon="dots" label={props.text.moreActions} disabled />
              <Button variant="ghost" icon="x" label={props.text.close} href={listHref()} keep />
            </>
          }
        />
      }
    >
      <Bar
        start={
          <Inline>
            <Text type="meta">{props.text.messages({ count: item()?.messageCount ?? data().detailMessages.length })}</Text>
            {statusChip()}
            <For each={tags()}>
              {(tag) => (
                <Chip tag color={tag.color}>
                  {tag.name}
                </Chip>
              )}
            </For>
            <Show when={c().canWrite() && item()}>
              {(open) => (
                <Chip icon="plus" onClick={() => void c().manageConversationTags(open())}>
                  {props.text.tag}
                </Chip>
              )}
            </Show>
          </Inline>
        }
        end={
          <Show when={readers().length > 0}>
            <For each={readers().slice(0, 3)}>{(reader) => <Avatar name={reader.displayName} />}</For>
            <Text type="meta">
              {props.text.reading({
                names: readers()
                  .map((reader) => reader.displayName)
                  .join(", "),
              })}
            </Text>
          </Show>
        }
      />
      <Show when={data().conversationSummary?.summary}>
        {(summary) => (
          <Notice tone="ai" title={props.text.shortly}>
            {summary()}
          </Notice>
        )}
      </Show>
      <Show when={data().detailError}>{(error) => <Notice tone="bad">{error()}</Notice>}</Show>
      {props.reply?.(replyRequest)}
      <For each={timeline()}>
        {(entry) =>
          entry.kind === "message" ? (
            <MessageV2
              message={entry.message}
              mailboxId={data().mailbox.id}
              identities={data().identities}
              controller={c()}
              dateConfig={props.dateConfig}
              text={props.text}
              onReply={c().canWrite() ? () => setReplyRequest((count) => count + 1) : undefined}
            />
          ) : (
            <Notice
              tone="note"
              title={entry.note.body === null ? props.text.noteDeleted : props.text.noteBy({ name: entry.note.author.displayName })}
              meta={mailV2MessageTime(entry.note.createdAt, props.dateConfig)}
            >
              {entry.note.body ?? ""}
            </Notice>
          )
        }
      </For>
    </Pane>
  );
}
