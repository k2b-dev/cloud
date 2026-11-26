import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { swapPage } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { dates } from "@k2b/stdlib";
import { mutation } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import {
  Avatar,
  Bar,
  Button,
  Canvas,
  Cells,
  Dialog,
  Digest,
  Empty,
  type Fact,
  Facts,
  Failed,
  Field,
  Group,
  Icon,
  Inline,
  Input,
  List,
  Mark,
  Menu,
  type MarkProps,
  type NavProps,
  Notice,
  Pane,
  Row,
  Section,
  type Status,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { KeptConversationExport } from "../../../contracts";
import type { KeepHistoryEntry } from "../../../service/kept-conversations";
import { mailKeptAdminMessages } from "../../kept-admin-messages";
import { readApiError } from "../api-response";
import { downloadKeptConversations } from "../kept-admin-download";
import { keptMark } from "./mail-admin-kept-mark";

type KeptConversation = KeptConversationExport["conversations"][number];
type KeptMessage = KeptConversation["messages"][number];
type Address = KeptMessage["from"][number];
type Attachment = KeptMessage["attachments"][number];
type DeliveryState = NonNullable<KeptMessage["delivery"]>["state"];

export type MailAdminKeptRecordProps = {
  /** The admin bar, as the page built it with `adminNavigation(c, mailAdminSections(…))`. */
  nav: NavProps;
  /** The kept conversation; absent when it is not kept (any more) or could not be loaded. */
  record?: { conversation: KeptConversation; history: KeepHistoryEntry[]; messageCount: number };
  /** Why there is no record: not kept, or a failure worded for the page. */
  missing?: { notFound: true } | { notFound: false; text: string };
  dateConfig: DateContext;
};

const LIST_PATH = "/admin/mail/kept";
const REASON_MAX_LENGTH = 500;

const addressText = (addresses: readonly Address[]): string =>
  addresses.map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address)).join(", ");

const formatBytes = (value: number, locale: string): string => {
  const format = (number: number, digits: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(number);
  if (value < 1024) return `${format(value, 0)} B`;
  if (value < 1024 * 1024) return `${format(value / 1024, 1)} KB`;
  return `${format(value / (1024 * 1024), 1)} MB`;
};

/** The mark of an attachment by its type, the same as Files shows for it. */
const attachmentMark = (attachment: Attachment): MarkProps => {
  const type = attachment.contentType.toLowerCase();
  if (type === "application/pdf") return { icon: "file-type-pdf", color: "#dc2626", kind: "PDF" };
  if (type.startsWith("image/")) return { icon: "photo", color: "#7c3aed" };
  if (type.includes("spreadsheet") || type.includes("excel") || type === "text/csv") return { icon: "table", color: "#15803d" };
  if (type.includes("word") || type.startsWith("text/")) return { icon: "file-text", color: "#2563eb" };
  return { icon: "file" };
};

/**
 * Stored HTML is already sanitized. The frame still runs nothing and loads nothing from the network, so opening kept
 * mail as evidence can't execute content or tell a sender that an administrator read it.
 */
const htmlFrameDocument = (html: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#18181b;background:#fff;overflow-wrap:anywhere}</style></head><body>${html}</body></html>`;

/**
 * One kept conversation in Cloud administration › Mail › Kept on v2, after the record recipe: its mark and subject in
 * the head with the download and the end of keeping, three key figures, its messages as evidence, and beside them
 * where it lives and its logged history.
 */
export default function MailAdminKeptRecord(props: MailAdminKeptRecordProps) {
  const locale = useLocale();
  const t = createMemo(() => mailKeptAdminMessages.resolve([locale()]).t);
  const toast = useToast();
  const [asking, setAsking] = createSignal(false);
  const [reason, setReason] = createSignal("");
  // why the last try to stop keeping failed; the dialog shows it until it is asked again
  const [refusal, setRefusal] = createSignal<string>();
  const subject = () => props.record?.conversation.subject?.trim() || t().noSubject;
  const ref = () => ({
    mailboxId: props.record?.conversation.mailbox.id ?? "",
    conversationId: props.record?.conversation.conversationId ?? "",
  });
  const when = (iso: string) => dates.formatDateTime(iso, props.dateConfig);
  const day = (iso: string) => dates.formatDate(iso, props.dateConfig);

  const download = mutation.create<void, void>({
    mutation: (_, { abortSignal }) => downloadKeptConversations([ref()], t().downloadFailed, abortSignal),
    onSuccess: () => toast(t().downloadStarted, { status: "ok" }),
    onError: (error) => toast(error.message, { status: "bad", retry: () => void download.mutate() }),
  });
  const release = mutation.create<void, void>({
    mutation: async (_, { abortSignal }) => {
      setRefusal(undefined);
      const text = reason().trim();
      const response = await apiClient.admin.kept[":mailboxId"][":conversationId"].$delete(
        { param: ref(), json: text ? { reason: text } : {} },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().stopKeepingFailed));
    },
    onSuccess: () => {
      setAsking(false);
      toast(t().stopKeepingDone, { status: "ok" });
      void swapPage(LIST_PATH, { replace: true });
    },
    onError: (error) => setRefusal(error.message),
  });
  const ask = () => {
    setRefusal(undefined);
    setReason("");
    setAsking(true);
  };

  // Cloud's own outgoing copy is evidence only of what Cloud did with it: a cancelled or scheduled message never left.
  const delivery = (state: DeliveryState): { label: string; icon: string; tone?: Status } => {
    if (state === "scheduled") return { label: t().deliveryScheduled, icon: "clock" };
    if (state === "undo_window") return { label: t().deliveryPending, icon: "clock" };
    if (state === "sending") return { label: t().deliverySending, icon: "send" };
    if (state === "accepted" || state === "sent_sync_pending" || state === "sent" || state === "reconciled_accepted")
      return { label: t().deliverySent, icon: "circle-check", tone: "ok" };
    if (state === "failed") return { label: t().deliveryFailed, icon: "alert-circle", tone: "bad" };
    if (state === "cancelled" || state === "reconciled_unsent") return { label: t().deliveryNotSent, icon: "circle-minus", tone: "warn" };
    return { label: t().deliveryUnknown, icon: "help-circle", tone: "warn" };
  };
  const historyVerb = (entry: KeepHistoryEntry): string => {
    if (entry.action === "mail.conversation.keep") return t().historyKept;
    if (entry.action === "mail.conversation.keep.release")
      return entry.outcome === "allowed" ? t().historyReleased : t().historyReleaseDenied;
    if (entry.action === "mail.conversation.keep.view") return t().historyViewed;
    if (entry.action === "mail.conversation.keep.export") return t().historyExported;
    return t().historyOther({ action: entry.action });
  };
  const messageFacts = (message: KeptMessage): Fact[] => {
    const facts: Fact[] = [];
    const from = addressText(message.from);
    facts.push({ label: t().from, value: from || t().unknownSender });
    if (message.to.length) facts.push({ label: t().to, value: addressText(message.to) });
    if (message.cc.length) facts.push({ label: t().cc, value: addressText(message.cc) });
    if (message.bcc.length) facts.push({ label: t().bcc, value: addressText(message.bcc) });
    if (message.replyTo.length) facts.push({ label: t().replyTo, value: addressText(message.replyTo) });
    if (message.messageId) facts.push({ label: t().messageIdHeader, value: message.messageId, mono: true });
    return facts;
  };

  return (
    <AdminWorkspace
      nav={props.nav}
      head={
        <Bar
          start={
            <Show when={props.record} fallback={<Text type="lead">{t().tabKept}</Text>}>
              <Inline>
                <Mark {...keptMark(false)} />
                <Text type="lead">{subject()}</Text>
              </Inline>
            </Show>
          }
          end={
            <Show when={props.record}>
              {/* both stay on the phone, where a head keeps only its symbols */}
              <Button icon="download" label={t().downloadJson} keep busy={download.loading()} onClick={() => void download.mutate()} />
              <Menu label={t().moreActions} items={[{ label: t().stopKeeping, icon: "lock-open", danger: true, onClick: ask }]} />
            </Show>
          }
        />
      }
    >
      <Show
        when={props.record}
        fallback={
          <Pane label={t().tabKept}>
            <Show
              when={props.missing?.notFound === false ? props.missing.text : undefined}
              fallback={<Empty icon="lock-off" text={t().detailNotFound} action={{ label: t().backToList, href: LIST_PATH }} />}
            >
              {(text) => <Failed text={text()} onRetry={() => void swapPage(location.href)} />}
            </Show>
          </Pane>
        }
      >
        {(record) => {
          const conversation = () => record().conversation;
          const messages = () => conversation().messages;
          const newest = () =>
            messages().reduce<string | undefined>(
              (latest, message) => (!latest || message.date > latest ? message.date : latest),
              undefined,
            );
          const attachments = () => messages().flatMap((message) => message.attachments.filter((attachment) => !attachment.inline));
          return (
            <Pane label={subject()} scrollKey="mail-admin-kept-record">
              {/* A status band only when something needs attention: the record shows fewer messages than it keeps. */}
              <Show when={record().messageCount > messages().length}>
                <Notice
                  tone="warn"
                  title={t().truncatedTitle}
                  actions={[{ label: t().downloadJson, icon: "download", onClick: () => void download.mutate() }]}
                >
                  {t().truncated({ shown: messages().length, total: record().messageCount })}
                </Notice>
              </Show>
              <Cells>
                <Cells.Cell
                  icon="mail"
                  color={keptMark(false).color}
                  label={t().cellMessages}
                  value={new Intl.NumberFormat(locale()).format(record().messageCount)}
                  meta={newest() ? t().newestOn({ date: day(newest()!) }) : undefined}
                />
                <Cells.Cell
                  icon="lock"
                  label={t().columnKeptSince}
                  value={day(conversation().keep.keptAt)}
                  meta={t().byName({ name: conversation().keep.keptBy.displayName })}
                />
                <Cells.Cell
                  icon="paperclip"
                  label={t().attachments}
                  value={new Intl.NumberFormat(locale()).format(attachments().length)}
                  meta={
                    attachments().length
                      ? formatBytes(
                          attachments().reduce((sum, attachment) => sum + attachment.size, 0),
                          locale(),
                        )
                      : t().noAttachments
                  }
                />
              </Cells>
              <Pane.Split>
                <Pane label={t().messages({ count: record().messageCount })}>
                  <Section icon="mail" color={keptMark(false).color} title={t().cellMessages} count={record().messageCount}>
                    <For each={messages()}>
                      {(message) => {
                        const sender = () => message.from[0]?.name || message.from[0]?.address || t().unknownSender;
                        const state = () => (message.delivery ? delivery(message.delivery.state) : undefined);
                        return (
                          <Group
                            icon={message.delivery ? "send" : "mail"}
                            title={sender()}
                            meta={<time dateTime={message.date}>{when(message.date)}</time>}
                            state={
                              <Show when={state()}>
                                {(shown) => (
                                  <Text weight="medium" tone={shown().tone}>
                                    <Icon name={shown().icon} /> {shown().label}
                                  </Text>
                                )}
                              </Show>
                            }
                          >
                            <Facts items={messageFacts(message)} />
                            <Show when={message.text || message.html} fallback={<Text muted>{t().noBody}</Text>}>
                              <Canvas label={t().messageText} height={message.text ? undefined : 320}>
                                <Show
                                  when={message.text}
                                  fallback={
                                    <iframe
                                      width="100%"
                                      height="100%"
                                      sandbox=""
                                      referrerpolicy="no-referrer"
                                      title={message.subject ?? t().noSubject}
                                      srcdoc={htmlFrameDocument(message.html ?? "")}
                                    />
                                  }
                                >
                                  {/* The kept text as Cloud stored it: its own line breaks, on the text edge. */}
                                  <div
                                    style={{
                                      "padding-inline": "var(--k2-edge)",
                                      "white-space": "pre-wrap",
                                      "overflow-wrap": "anywhere",
                                      font: "400 14px/22px var(--k2-font, inherit)",
                                    }}
                                  >
                                    {message.text}
                                  </div>
                                </Show>
                              </Canvas>
                            </Show>
                            <Show when={message.attachments.length}>
                              <List label={t().attachments}>
                                <For each={message.attachments}>
                                  {(attachment) => (
                                    <Row
                                      mark={attachmentMark(attachment)}
                                      lines={[
                                        attachment.filename ?? attachment.contentType,
                                        attachment.inline ? `${attachment.contentType} · ${t().inline}` : attachment.contentType,
                                      ]}
                                      time={formatBytes(attachment.size, locale())}
                                    />
                                  )}
                                </For>
                              </List>
                            </Show>
                          </Group>
                        );
                      }}
                    </For>
                  </Section>
                </Pane>
                <Pane side label={t().keepSection} width={{ min: 280, default: 340 }}>
                  <Section icon="info-circle" title={t().keepSection}>
                    <Facts
                      items={[
                        { label: t().mailboxLabel, value: conversation().mailbox.name },
                        {
                          label: t().columnKeptBy,
                          value: (
                            <Inline>
                              <Avatar name={conversation().keep.keptBy.displayName} decorative />
                              <Text>{conversation().keep.keptBy.displayName}</Text>
                            </Inline>
                          ),
                        },
                        {
                          label: t().columnKeptSince,
                          value: <time dateTime={conversation().keep.keptAt}>{when(conversation().keep.keptAt)}</time>,
                        },
                        { label: t().cloudId, value: conversation().cloudId, mono: true, copy: conversation().cloudId },
                      ]}
                    />
                  </Section>
                  <Section icon="history" title={t().history} count={record().history.length || undefined}>
                    <Show when={record().history.length} fallback={<Empty icon="history" text={t().historyEmpty} />}>
                      <Digest
                        label={t().history}
                        activity={record().history.map((entry) => ({
                          person: { name: entry.actor.label },
                          text: (
                            <>
                              <Text weight="strong">{entry.actor.label}</Text>{" "}
                              <Text tone={entry.outcome === "allowed" ? undefined : "bad"}>{historyVerb(entry)}</Text>
                              {entry.reason ? ` · ${t().historyReason({ reason: entry.reason })}` : ""}
                            </>
                          ),
                          time: when(entry.at),
                        }))}
                      />
                    </Show>
                  </Section>
                </Pane>
              </Pane.Split>
            </Pane>
          );
        }}
      </Show>
      <Dialog
        title={t().stopKeepingTitle}
        open={asking()}
        onOpenChange={(open) => {
          if (!open && !release.loading()) setAsking(false);
        }}
        foot={
          <>
            <Button onClick={() => setAsking(false)} disabled={release.loading()}>
              {t().cancel}
            </Button>
            <Button
              variant="primary"
              icon="lock-open"
              busy={release.loading()}
              disabled={reason().trim().length > REASON_MAX_LENGTH}
              onClick={() => void release.mutate()}
            >
              {t().stopKeeping}
            </Button>
          </>
        }
      >
        <Text>{t().stopKeepingConsequence}</Text>
        <Field
          label={t().stopKeepingReason}
          hint={t().stopKeepingReasonDescription}
          error={reason().trim().length > REASON_MAX_LENGTH ? t().reasonTooLong({ max: REASON_MAX_LENGTH }) : undefined}
        >
          <Input multiline value={reason()} disabled={release.loading()} onInput={setReason} />
        </Field>
        <Show when={refusal()}>
          {(text) => (
            <Notice tone="bad" title={t().stopKeepingFailed}>
              {text()}
            </Notice>
          )}
        </Show>
      </Dialog>
    </AdminWorkspace>
  );
}
