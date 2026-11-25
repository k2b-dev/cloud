import { importOnDemand } from "@k2b/cloud/browser/reload";
import type { DateContext } from "@k2b/stdlib";
import { prompts, toast, useLocale } from "@k2b/ui";
import { Avatar, Band, Bar, Button, Canvas, Chip, Cut, Inline, Menu, Notice, Pane, Popover, Row, Text, Tiles } from "@k2b/ui/v2";
import { createMemo, createSignal, For, on, Show } from "solid-js";
import type { DraftDerivationKind, SenderIdentity } from "../../../contracts";
import type { MailWorkspaceMessage } from "../../../service/workspace";
import type { MailboxController } from "../../mail-workspace";
import MailMessageBody from "../MailMessageBody";
import { createMailMessageMenu } from "../MailSenderMessageActions";
import { useMailCloudUrl } from "../mail-cloud-id";
import { deriveReplyRecipients } from "../mail-compose-derivation";
import { isOutgoingMessage } from "../mail-conversation-history";
import { type MailRespondIntent, mailConversationMenuItems } from "../mail-conversation-menu";
import { buildMailConversationTimeline } from "../mail-conversation-timeline";
import { mailConversationUiMessages } from "../mail-conversation-ui-messages";
import { createMailMessageDerive } from "../mail-derive-message";
import { mailMessageMessages } from "../mail-message-messages";
import { normalizeContentId, referencedContentIds, resolveMessageBodyFormat, resolveMessageColors } from "../mail-message-presentation";
import { buildMailListHref, mailRouteUrl } from "../mail-navigation";
import { mailReaderMessages } from "../mail-reader-messages";
import { mailSenderIdentityStatusMessages, senderUnavailableDetail } from "../mail-sender-identity-status";
import { createMailV2Reply, type MailV2Session } from "./MailReplyV2";
import { mailV2MenuEntries } from "./mail-v2-menu";
import type { MailV2Text } from "./mail-v2-messages";
import { createMailV2ReaderMenus } from "./mail-v2-reader-menus";
import { mailV2MessageTime } from "./mail-v2-time";

/**
 * The message frame's defaults on v2 (mockup mail.html): reading text in IBM Plex Sans 14/22 (the frame loads Cloud's
 * shared faces, `sharedFontsOrigin`; system-ui stands in until they arrive) in the second text colour (n800), 8 px between
 * paragraphs and none above the first or after the last, so the attachments follow at the band's own gap. The frame
 * cannot read the page's tokens, so the values stand here; each selector weighs no more than a message's own, which
 * follow and win, so an HTML mail keeps its fonts and spacing.
 */
const MAIL_V2_FRAME_STYLE =
  'body { font-family: "IBM Plex Sans", system-ui, sans-serif; font-size: 14px; line-height: 22px; color: #27272a; } ' +
  "p { margin: 0 0 8px; } p:last-child { margin-bottom: 0; }";

const attachmentIcon = (contentType: string, name: string): string => {
  if (contentType === "application/pdf" || name.toLowerCase().endsWith(".pdf")) return "file-type-pdf";
  if (contentType.startsWith("image/")) return "photo";
  if (contentType.startsWith("text/")) return "file-text";
  return "file";
};

/** A file's size as people read it: "0 B", "512 B", "13 KB", "4,5 MB" (never "1 KB" for an empty file). */
export const formatSize = (bytes: number, locale: string): string => {
  const size = Math.max(0, bytes);
  if (size < 1024) return `${new Intl.NumberFormat(locale).format(Math.round(size))} B`;
  if (size < 1024 * 1024) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(size / 1024))} KB`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(size / (1024 * 1024))} MB`;
};

/** How many tags and faces of readers the reader's state line shows before "+N" and a count. */
const SHOWN_TAGS = 3;
const SHOWN_READERS = 3;

/** How many recipients a message's line names before the rest folds into "+N". */
const NAMED_RECIPIENTS = 2;

/** An address standing alone as a name: cut in the middle, so its domain stays readable. */
const isAddress = (text: string) => /^[^\s@]+@[^\s@]+$/.test(text);

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
  /** Answers this message in the conversation's reply: Reply, Reply all or Forward from the message's "…". */
  onRespond?: (intent: MailRespondIntent, message: MailWorkspaceMessage) => void;
  /** "Use as new" of the message's "…" (absent where the person cannot write). */
  onDerive?: (kind: DraftDerivationKind, message: MailWorkspaceMessage) => unknown;
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
    // many recipients fold into "+N" after the first two, so the line stays one line before the time
    const names = props.message.to.map((address) => address.name || address.address);
    const rest = names.length - NAMED_RECIPIENTS;
    const recipients =
      names.length === 0
        ? t().undisclosedRecipients
        : rest > 0
          ? `${names.slice(0, NAMED_RECIPIENTS).join(", ")} ${props.text.andMore({ count: rest })}`
          : names.join(", ");
    return !outgoing() && props.message.to.some((recipient) => own.has(recipient.address.trim().toLowerCase()))
      ? t().toMe
      : t().toRecipient({ recipients });
  };
  // A sender known only by an address shows it once, cut in the middle; a named sender's address follows quietly.
  const senderLine = () => {
    const name = senderName();
    return isAddress(name) ? <Cut text={name} keep="domain" /> : name;
  };
  const senderAddress = () => {
    const address = sender()?.address;
    return outgoing() || !address || address === senderName() ? undefined : <Cut text={address} keep="domain" />;
  };
  const when = () => mailV2MessageTime(props.message.sentAt ?? props.message.internalDate, props.dateConfig);
  // Cloud's origin from the server: the frame's typeface loads from there, the same document in SSR and the browser.
  const cloudUrl = useMailCloudUrl();
  // The message's "…" is v1's message menu (MailSenderMessageActions); "Use as new" joins with the rebuilt reply.
  const c = () => props.controller;
  const menu = createMailMessageMenu({
    get mailboxId() {
      return props.mailboxId;
    },
    get requestUrl() {
      return c().requestPath();
    },
    get canWrite() {
      return c().canWrite();
    },
    get canAdmin() {
      return c().canAdmin();
    },
    get mailboxWide() {
      return !c().assignedOnly();
    },
    get selectionKey() {
      return c().data.selectedMessageId ?? c().data.selectedConversationId;
    },
    get selectedConversationId() {
      return c().data.selectedConversationId;
    },
    get message() {
      return props.message;
    },
    get totalMessageCount() {
      return c().selectedListItem()?.messageCount ?? c().data.detailMessages.length;
    },
    get identities() {
      return props.identities;
    },
    get conversationMessages() {
      return c().data.detailMessages;
    },
    onReassignMessage: (messageId) => c().reassignMessage(messageId),
    get onDeriveMessage() {
      return props.onDerive;
    },
    onSplitMessage: (messageId) => c().splitMessage(messageId),
    // Reply, Reply all and Forward lead, as in v1's message menu (MailMessageCard's response actions).
    get primaryActions() {
      const respond = props.onRespond;
      if (!respond) return [];
      const replyAll = deriveReplyRecipients(props.message, "reply_all", props.identities).cc.length > 0;
      return mailConversationMenuItems({
        t: mailConversationUiMessages.resolve([locale()]).t,
        respond: { replyAll, run: (intent) => respond(intent, props.message) },
      });
    },
  });
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
      name: attachment.filename?.trim() || props.text.unnamedAttachment,
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
        lines={[senderLine(), `${route()} · ${when()}`]}
        meta={senderAddress()}
        end={
          <>
            <Show when={props.onReply}>
              {(reply) => <Button variant="ghost" icon="arrow-back-up" label={props.text.reply} onClick={() => reply()()} />}
            </Show>
            <Menu label={menu.label()} items={mailV2MenuEntries(menu.items())} />
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
                frameStyle={MAIL_V2_FRAME_STYLE}
                sharedFontsOrigin={cloudUrl ?? undefined}
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
            title: attachment.filename?.trim() || props.text.unnamedAttachment,
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
  session: MailV2Session;
}) {
  const locale = useLocale();
  const readerText = createMemo(() => mailReaderMessages.resolve([locale()]).t);
  const c = () => props.controller;
  const data = () => c().data;
  const item = () => c().selectedListItem();
  const listHref = () => buildMailListHref(mailRouteUrl(c().requestPath()));
  const [replyRequest, setReplyRequest] = createSignal(0);
  /** Names why no verified sender can send, and lets a mailbox admin open the setting that fixes it (v1's reader). */
  const explainSenderUnavailable = async () => {
    const mailboxId = data().mailbox.id;
    const status = mailSenderIdentityStatusMessages.resolve([locale()]).t;
    const detail = senderUnavailableDetail(data().identities, locale());
    if (!c().canAdmin()) return void (await prompts.error(`${detail} ${status.askAdmin}`, { title: status.cannotSend }));
    const open = await prompts.confirm(detail, { title: status.cannotSend, confirmText: status.openSenderSettings });
    if (open && mailboxId === data().mailbox.id) void c().openSettings("delivery");
  };
  // "Use as new" of a message: one draft seed at a time, a failure says why (v1's, shared).
  const derive = createMailMessageDerive({
    mailboxId: () => data().mailbox.id,
    identities: () => data().identities,
    currentUserId: () => props.session.currentUserId,
    returnHref: () => c().requestPath(),
    selection: () => data().selectedConversationId,
    shows: (messageId) => data().detailMessages.some((shown) => shown.id === messageId),
    explainSenderUnavailable,
  });
  // One reply per conversation: another conversation, or another mailbox, starts at rest again.
  const reply = createMemo(
    on(
      () => `${data().mailbox.id}:${data().selectedConversationId ?? ""}`,
      () =>
        data().selectedConversationId
          ? createMailV2Reply({
              controller: c(),
              session: props.session,
              dateConfig: props.dateConfig,
              text: () => props.text,
              request: replyRequest,
            })
          : null,
    ),
  );
  // Newest first, each internal note at the time it was written, as v1's reader with the reply on top.
  const timeline = createMemo(() => buildMailConversationTimeline(data().detailMessages, data().comments).reverse());
  const tags = () => data().conversationLocalTags?.tags ?? item()?.localTags ?? [];
  const assignees = () => data().collaborationState?.assignees ?? [];
  const readers = () => c().presence().participants;
  const workStatus = () => c().selectedWorkStatus();
  const menus = createMailV2ReaderMenus({
    controller: c,
    dateConfig: props.dateConfig,
    reply: () => {
      const open = reply();
      return open?.shown() ? { respond: (intent) => open.respond(intent), canReplyAll: open.canReplyAll } : null;
    },
  });
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
      back={{ label: data().listTitle, href: listHref(), onNavigate: (nav) => c().closeConversation(nav) }}
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
              </Show>
              <Menu icon="clock" label={props.text.later} items={menus.later()} />
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
              <Menu items={menus.more()} />
              <Button
                variant="ghost"
                icon="x"
                label={props.text.close}
                href={listHref()}
                onNavigate={(nav) => c().closeConversation(nav)}
              />
            </>
          }
        />
      }
      // The conversation's state stays under the head while the reader scrolls (Pane status).
      status={
        <Bar
          start={
            <Inline>
              <Text type="meta">{props.text.messages({ count: item()?.messageCount ?? data().detailMessages.length })}</Text>
              {statusChip()}
              {/* At most three tags stand in the line, which stays under the head while the reader scrolls; the rest
                  wait behind "+N" (break-ui 25.11.: 50 tags left no room to read). */}
              <For each={tags().slice(0, SHOWN_TAGS)}>
                {(tag) => (
                  <Chip tag color={tag.color}>
                    {tag.name}
                  </Chip>
                )}
              </For>
              <Show when={tags().length > SHOWN_TAGS}>
                <Popover
                  variant="ghost"
                  label={props.text.allTags}
                  title={props.text.allTags}
                  content={
                    <Inline>
                      <For each={tags()}>
                        {(tag) => (
                          <Chip tag color={tag.color}>
                            {tag.name}
                          </Chip>
                        )}
                      </For>
                    </Inline>
                  }
                >
                  {props.text.andMore({ count: tags().length - SHOWN_TAGS })}
                </Popover>
              </Show>
              {/* What other apps linked to the conversation: one item opens directly, several in a menu (v1's chip). */}
              <Show when={menus.linked().length > 0}>
                <Show
                  when={menus.linked().length === 1 ? menus.linked()[0] : null}
                  fallback={
                    <Menu
                      icon="link"
                      items={menus
                        .linked()
                        .map((linked) => ({ label: linked.title, icon: linked.icon.replace(/^ti\s+ti-/, ""), href: linked.href }))}
                    >
                      {readerText().linkedCount({ count: menus.linked().length })}
                    </Menu>
                  }
                >
                  {(only) => (
                    <Chip icon="link" href={only().href}>
                      {readerText().linkedCount({ count: 1 })}
                    </Chip>
                  )}
                </Show>
              </Show>
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
            // Who reads along: their faces and how many; their names on the faces and behind the count.
            <Show when={readers().length > 0}>
              <For each={readers().slice(0, SHOWN_READERS)}>{(reader) => <Avatar name={reader.displayName} />}</For>
              <Popover
                variant="text"
                title={props.text.readers}
                content={<Text>{readers().map((reader) => reader.displayName).join(", ")}</Text>}
              >
                {props.text.reading({ count: readers().length })}
              </Popover>
            </Show>
          }
        />
      }
    >
      <Show when={data().conversationSummary?.summary}>
        {(summary) => (
          <Notice
            tone="ai"
            title={props.text.shortly}
            actions={
              c().canWrite()
                ? [{ label: props.text.edit, disabled: menus.summary.saving(), onClick: () => void menus.summary.edit() }]
                : undefined
            }
          >
            {summary()}
          </Notice>
        )}
      </Show>
      <Show when={data().detailError}>{(error) => <Notice tone="bad">{error()}</Notice>}</Show>
      <Show when={reply()?.shown() ? reply() : null}>
        {(open) => (
          <Show when={open().writing()} fallback={open().rest()}>
            <Canvas label={open().label()}>
              {/* Mail's own reply box, framed by itself, keeps the place of the resting composer: 12 px above and below, 8 px from the column's edges. */}
              <div style={{ padding: "12px 8px" }}>{open().box()}</div>
            </Canvas>
          </Show>
        )}
      </Show>
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
              onRespond={reply()?.shown() ? (intent, message) => reply()?.respond(intent, message) : undefined}
              onDerive={c().canWrite() && props.session.currentUserId ? derive.derive : undefined}
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
