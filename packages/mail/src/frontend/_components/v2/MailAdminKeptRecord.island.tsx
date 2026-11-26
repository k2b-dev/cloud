import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { swapPage } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { dates } from "@k2b/stdlib";
import { mutation } from "@k2b/stdlib/solid";
import {
  Avatar,
  Band,
  Bar,
  Button,
  Canvas,
  Dialog,
  Empty,
  type Fact,
  Facts,
  Failed,
  Field,
  Icon,
  Inline,
  Input,
  List,
  type NavProps,
  Notice,
  Pane,
  Path,
  Row,
  Section,
  type Status,
  Text,
  useLocale,
  useToast,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { KeptConversationExport } from "../../../contracts";
import type { KeepHistoryEntry } from "../../../service/kept-conversations";
import { mailKeptAdminMessages } from "../../kept-admin-messages";
import { readApiError } from "../api-response";
import { downloadKeptConversations } from "../kept-admin-download";

type KeptConversation = KeptConversationExport["conversations"][number];
type KeptMessage = KeptConversation["messages"][number];
type Address = KeptMessage["from"][number];
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

/**
 * Stored HTML is already sanitized. The frame still runs nothing and loads nothing from the network, so opening kept
 * mail as evidence can't execute content or tell a sender that an administrator read it.
 */
const htmlFrameDocument = (html: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#18181b;background:#fff;overflow-wrap:anywhere}</style></head><body>${html}</body></html>`;

/**
 * One kept conversation in Cloud administration › Mail › Kept on v2: its messages as evidence beside who kept it and
 * its logged history, with the download and the end of keeping in the head.
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
  const historyLabel = (entry: KeepHistoryEntry): string => {
    if (entry.action === "mail.conversation.keep") return t().historyKept;
    if (entry.action === "mail.conversation.keep.release")
      return entry.outcome === "allowed" ? t().historyReleased : t().historyReleaseDenied;
    if (entry.action === "mail.conversation.keep.view") return t().historyViewed;
    if (entry.action === "mail.conversation.keep.export") return t().historyExported;
    return t().historyOther({ action: entry.action });
  };
  const messageFacts = (message: KeptMessage): Fact[] => {
    const facts: Fact[] = [];
    if (message.to.length) facts.push({ label: t().to, value: addressText(message.to) });
    if (message.cc.length) facts.push({ label: t().cc, value: addressText(message.cc) });
    if (message.bcc.length) facts.push({ label: t().bcc, value: addressText(message.bcc) });
    if (message.replyTo.length) facts.push({ label: t().replyTo, value: addressText(message.replyTo) });
    if (message.delivery) {
      const state = delivery(message.delivery.state);
      facts.push({
        label: t().delivery,
        value: (
          <Text weight="medium" tone={state.tone}>
            <Icon name={state.icon} /> {state.label}
          </Text>
        ),
      });
    }
    if (message.messageId) facts.push({ label: t().messageIdHeader, value: message.messageId, mono: true });
    return facts;
  };

  return (
    <AdminWorkspace
      nav={props.nav}
      head={
        <Bar
          start={
            <Path
              label={t().tabsLabel}
              items={[
                { label: t().areaMail, href: "/admin/mail" },
                { label: t().tabKept, href: LIST_PATH },
                { label: props.record ? subject() : t().tabKept },
              ]}
            />
          }
          end={
            <Show when={props.record}>
              <Button icon="download" busy={download.loading()} onClick={() => void download.mutate()}>
                {t().downloadJson}
              </Button>
              <Button icon="lock-open" onClick={ask}>
                {t().stopKeeping}
              </Button>
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
        {(record) => (
          <Pane.Split>
            <Pane label={t().messages({ count: record().messageCount })} scrollKey="mail-admin-kept-record">
              <Show when={record().messageCount > record().conversation.messages.length}>
                <Notice tone="note" icon="info-circle">
                  {t().truncated({ shown: record().conversation.messages.length, total: record().messageCount })}
                </Notice>
              </Show>
              <For each={record().conversation.messages}>
                {(message) => {
                  const from = () => message.from[0];
                  const name = () => from()?.name || from()?.address || t().unknownSender;
                  return (
                    <Band label={message.subject ?? subject()}>
                      <Row
                        avatar={{ name: name() }}
                        strong
                        lines={[name(), <time dateTime={message.date}>{when(message.date)}</time>]}
                        meta={from()?.name ? from()?.address : undefined}
                      />
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
                            {/* The kept text as Cloud stored it: its own line breaks, on the text edge of the band. */}
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
                                icon="paperclip"
                                lines={[
                                  attachment.filename ?? attachment.contentType,
                                  `${attachment.contentType} · ${formatBytes(attachment.size, locale())}${attachment.inline ? ` · ${t().inline}` : ""}`,
                                ]}
                              />
                            )}
                          </For>
                        </List>
                      </Show>
                    </Band>
                  );
                }}
              </For>
            </Pane>
            <Pane side label={t().keepSection} width={{ min: 280, default: 340 }}>
              <Section icon="lock" title={t().keepSection}>
                <Facts
                  items={[
                    {
                      label: t().columnKeptSince,
                      value: <time dateTime={record().conversation.keep.keptAt}>{when(record().conversation.keep.keptAt)}</time>,
                    },
                    {
                      label: t().columnKeptBy,
                      value: (
                        <Inline>
                          <Avatar name={record().conversation.keep.keptBy.displayName} decorative />
                          <Text>{record().conversation.keep.keptBy.displayName}</Text>
                        </Inline>
                      ),
                    },
                    { label: t().mailboxLabel, value: record().conversation.mailbox.name },
                    { label: t().cloudId, value: record().conversation.cloudId, mono: true, copy: record().conversation.cloudId },
                  ]}
                />
              </Section>
              <Section icon="history" title={t().history} count={record().history.length || undefined}>
                <Show when={record().history.length} fallback={<Text muted>{t().historyEmpty}</Text>}>
                  <List label={t().history}>
                    <For each={record().history}>
                      {(entry) => (
                        <Row
                          avatar={{ name: entry.actor.label }}
                          lines={
                            entry.reason
                              ? [
                                  <Text tone={entry.outcome === "allowed" ? undefined : "bad"}>{historyLabel(entry)}</Text>,
                                  t().historyReason({ reason: entry.reason }),
                                  `${entry.actor.label} · ${when(entry.at)}`,
                                ]
                              : [
                                  <Text tone={entry.outcome === "allowed" ? undefined : "bad"}>{historyLabel(entry)}</Text>,
                                  `${entry.actor.label} · ${when(entry.at)}`,
                                ]
                          }
                        />
                      )}
                    </For>
                  </List>
                </Show>
              </Section>
            </Pane>
          </Pane.Split>
        )}
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
            <Button variant="primary" icon="lock-open" busy={release.loading()} onClick={() => void release.mutate()}>
              {t().stopKeeping}
            </Button>
          </>
        }
      >
        <Text>{t().stopKeepingConsequence}</Text>
        <Field label={t().stopKeepingReason} hint={t().stopKeepingReasonDescription}>
          <Input multiline value={reason()} maxLength={REASON_MAX_LENGTH} disabled={release.loading()} onInput={setReason} />
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
